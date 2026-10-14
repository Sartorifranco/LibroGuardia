/**
 * Funcionalidad transversal de sistema / gerencial:
 * búsqueda global, actividad, auditoría, reportes, notificaciones, alertas de vencimiento.
 */

const express = require('express');
const { db } = require('../firestore');
const { normalizeIdNumber, normalizePlate } = require('../permissions');
const { getAuthorizationLabel } = require('../authorizations');
const { listAuditLog, logAdminAction } = require('../lib/auditLog');
const { getArgentinaDateString } = require('../lib/normalize');
const { buildReportsSummary, REPORTS_PERMISSION } = require('../reports');
const {
  getNotificationsConfig,
  publicNotificationsConfig,
  saveNotificationsConfig
} = require('../lib/notifications');
const { sendNotification } = require('../lib/notifications/email');
const {
  evaluateExpiry,
  buildExpiryMessage,
  resolveExpirationAlertScopes,
  shouldAlertAuthorizationExpiry
} = require('../lib/documentExpiry');
const {
  auth,
  requirePermission,
  requireAnyPermission,
  getUserPermissions,
  sendServerError
} = require('../middleware/auth');

const router = express.Router();

const addDaysToYmd = (ymd, days) => {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  d.setDate(d.getDate() + days);
  return getArgentinaDateString(d);
};

// Cada sección solo se incluye si el usuario tiene el permiso de lectura correspondiente.
const SEARCH_PERMISSIONS = ['master.personal.read', 'master.vehicles.read', 'entries.view'];

// La web pregunta si corre contra la nube o el hub del predio (el hub responde mode:'lan').
// Sin lecturas de Firestore.
router.get('/api/runtime', (_req, res) => {
  res.json({ mode: 'cloud' });
});

router.get('/api/search', auth, requireAnyPermission(SEARCH_PERMISSIONS), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ results: [] });
    }
    const isAdmin = req.user.role === 'admin';
    const perms = Array.isArray(req.userPermissions) ? req.userPermissions : [];
    const can = (permission) => isAdmin || perms.includes(permission);
    const needle = q.toLowerCase();
    const idNeedle = normalizeIdNumber(q) || needle;
    const plateNeedle = normalizePlate(q) || needle.replace(/\s+/g, '');
    const results = [];

    const personalSnap = can('master.personal.read')
      ? await db.collection('personalMaster').orderBy('name').limit(200).get()
      : { docs: [] };
    personalSnap.docs.forEach((doc) => {
      if (results.filter((r) => r.kind === 'personal').length >= 8) return;
      const data = doc.data() || {};
      const name = String(data.name || '');
      const idNumber = String(data.idNumber || data.idNumberNormalized || '');
      const hay = `${name} ${idNumber} ${data.nameLower || ''} ${data.idNumberNormalized || ''}`.toLowerCase();
      if (!hay.includes(needle) && !String(data.idNumberNormalized || '').includes(idNeedle)) return;
      results.push({
        kind: 'personal',
        id: doc.id,
        title: name || idNumber || doc.id,
        subtitle: idNumber ? `DNI ${idNumber}` : 'Personal',
        tab: 'personal'
      });
    });

    const vehiclesSnap = can('master.vehicles.read')
      ? await db.collection('vehiclesMaster').orderBy('plate').limit(200).get()
      : { docs: [] };
    vehiclesSnap.docs.forEach((doc) => {
      if (results.filter((r) => r.kind === 'vehicle').length >= 8) return;
      const data = doc.data() || {};
      const plate = String(data.plate || '');
      const driver = String(data.driver || '');
      const company = String(data.company || '');
      const hay = `${plate} ${driver} ${company} ${data.plateNormalized || ''}`.toLowerCase();
      const plateNorm = String(data.plateNormalized || '');
      if (!hay.includes(needle) && !plateNorm.includes(plateNeedle)) return;
      results.push({
        kind: 'vehicle',
        id: doc.id,
        title: plate || doc.id,
        subtitle: [driver, company].filter(Boolean).join(' · ') || 'Vehículo autorizado',
        tab: 'vehiculo'
      });
    });

    const { queryEntriesPage, matchesSearch } = require('../lib/entriesQuery');
    const endDate = getArgentinaDateString();
    const startDate = addDaysToYmd(endDate, -30);
    const page = can('entries.view')
      ? await queryEntriesPage(db, {
        startDate,
        endDate,
        limit: 80,
        type: 'todos',
        q
      })
      : { docs: [] };
    let entryCount = 0;
    for (const doc of page.docs) {
      if (entryCount >= 8) break;
      const data = doc.data() || {};
      if (!matchesSearch(data, q)) continue;
      const title = data.name || data.plate || data.mobile || data.description || 'Registro';
      const subtitleParts = [
        data.type,
        data.movementType,
        data.idNumber,
        data.company
      ].filter(Boolean);
      results.push({
        kind: 'entry',
        id: doc.id,
        title: String(title),
        subtitle: subtitleParts.join(' · ') || 'Historial (30 días)',
        tab: 'historial'
      });
      entryCount += 1;
    }

    res.json({ results });
  } catch (err) {
    sendServerError(res, err, 'Error en la búsqueda');
  }
});

router.get(
  '/api/admin/activity',
  auth,
  requireAnyPermission(['users.view', 'roles.view', 'settings.permissions', 'audit.view']),
  async (req, res) => {
    try {
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.floor(limitRaw), 1), 100)
        : 80;
      const { buildAuditSummary } = require('../lib/auditLabels');

      const [activitySnap, auditSnap] = await Promise.all([
        db.collection('activityLog').orderBy('createdAt', 'desc').limit(limit).get()
          .catch(() => ({ docs: [] })),
        db.collection('auditLog').orderBy('createdAt', 'desc').limit(limit).get()
          .catch(() => ({ docs: [] }))
      ]);

      const toIso = (value) => {
        if (!value) return null;
        if (typeof value.toDate === 'function') return value.toDate().toISOString();
        return value;
      };

      const fromActivity = (activitySnap.docs || []).map((doc) => {
        const data = doc.data() || {};
        return {
          id: `activity:${doc.id}`,
          source: 'activity',
          actorUsername: data.actorUsername || '',
          actorId: data.actorId || '',
          action: data.action || '',
          summary: data.summary || data.action || 'Acción',
          meta: data.meta || null,
          createdAt: toIso(data.createdAt)
        };
      });

      const fromAudit = (auditSnap.docs || []).map((doc) => {
        const data = doc.data() || {};
        const item = {
          id: `audit:${doc.id}`,
          source: 'audit',
          actorUsername: data.actorUsername || '',
          actorId: data.actorId || '',
          action: data.action || '',
          targetType: data.targetType || null,
          targetId: data.targetId || null,
          summary: buildAuditSummary(data),
          meta: {
            targetType: data.targetType || null,
            targetId: data.targetId || null,
            changedKeys: data.changedKeys || []
          },
          createdAt: toIso(data.createdAt)
        };
        return item;
      });

      const merged = [...fromActivity, ...fromAudit]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, limit);

      res.json({ activity: merged });
    } catch (err) {
      sendServerError(res, err, 'Error al obtener actividad');
    }
  }
);

router.get('/api/admin/audit-log', auth, requirePermission('audit.view'), async (req, res) => {
  try {
    const result = await listAuditLog({
      limit: req.query.limit,
      actorId: req.query.actorId,
      action: req.query.action,
      from: req.query.from,
      to: req.query.to,
      startAfter: req.query.startAfter
    });
    res.json(result);
  } catch (err) {
    sendServerError(res, err, 'Error al obtener auditoría');
  }
});

router.get('/api/reports/summary', auth, requirePermission(REPORTS_PERMISSION), async (req, res) => {
  try {
    const summary = await buildReportsSummary(db, {
      from: req.query.from,
      to: req.query.to
    });
    res.json(summary);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      return sendServerError(res, err, 'Error al generar el resumen de reportes');
    }
    res.status(status).json({
      message: err.message || 'Error al generar el resumen de reportes'
    });
  }
});

router.get('/api/admin/notifications-config', auth, requirePermission('notifications.config'), async (_req, res) => {
  try {
    const config = await getNotificationsConfig();
    res.json({ config: publicNotificationsConfig(config) });
  } catch (err) {
    sendServerError(res, err, 'Error al obtener notificaciones');
  }
});

router.put('/api/admin/notifications-config', auth, requirePermission('notifications.config'), async (req, res) => {
  try {
    const saved = await saveNotificationsConfig(req.body || {});
    logAdminAction({
      req,
      action: 'notifications.update',
      targetType: 'notifications',
      targetId: 'notificationsConfig',
      after: { enabled: saved.enabled === true }
    }).catch((err) => console.error('auditLog notifications.update:', err.message));
    res.json({
      message: 'Configuración de notificaciones guardada',
      config: publicNotificationsConfig(saved)
    });
  } catch (err) {
    sendServerError(res, err, 'Error al guardar notificaciones');
  }
});

router.post('/api/admin/notifications-config/test', auth, requirePermission('notifications.config'), async (req, res) => {
  try {
    const to = String(req.body?.to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ message: 'Escribí un mail válido para la prueba.' });
    }
    const config = await getNotificationsConfig();
    const result = await sendNotification({
      to: [to],
      subject: 'Prueba de avisos',
      text: 'Este es un aviso de prueba. Si lo recibiste, el correo está bien configurado.'
    }, { smtp: config.smtp });
    logAdminAction({
      req,
      action: 'notifications.test',
      targetType: 'notifications',
      targetId: 'notificationsConfig',
      after: { to, sent: result.sent === true }
    }).catch((err) => console.error('auditLog notifications.test:', err.message));
    if (!result.sent) {
      return res.status(400).json({
        message: 'No se pudo enviar. Completá el correo en Opciones avanzadas y guardá antes de probar.'
      });
    }
    res.json({ message: 'Prueba enviada. Revisá la bandeja de entrada.' });
  } catch (err) {
    sendServerError(res, err, 'Error al enviar la prueba');
  }
});

router.get(
  '/api/guard/expiration-alerts',
  auth,
  requireAnyPermission(['entries.view', 'master.citaciones.read', 'master.personal.read', 'master.vehicles.read']),
  async (req, res) => {
    try {
      const today = getArgentinaDateString();

      // Scopes solo desde permisos resueltos en middleware (Firestore), nunca desde el JWT crudo.
      // Así DevTools solo ve lo que el servidor armó para ese usuario.
      let resolvedPermissions = req.userPermissions;
      if (!Array.isArray(resolvedPermissions) && req.user.role !== 'admin') {
        const snap = await db.collection('users').doc(req.user.id).get();
        if (!snap.exists) {
          return res.status(404).json({ message: 'Usuario no encontrado' });
        }
        resolvedPermissions = await getUserPermissions(snap.data());
      }

      const scopes = resolveExpirationAlertScopes({
        role: req.user.role,
        permissions: Array.isArray(resolvedPermissions) ? resolvedPermissions : []
      });

      if (!scopes.authorizations && !scopes.personal && !scopes.vehicles) {
        return res.status(403).json({ message: 'Acceso denegado: permiso insuficiente' });
      }

      const buckets = {
        expired: [],
        endingIn7: [],
        endingIn15: [],
        endingIn30: []
      };

      const pushAlert = (item) => {
        const list = buckets[item.bucket];
        if (!list || list.length >= 40) return;
        list.push(item);
      };

      // Solo se leen colecciones del dominio autorizado: nada de ART/vehículos si no hay permiso.
      const fetches = [];
      if (scopes.authorizations) {
        fetches.push(
          db.collection('authorizations').where('active', '==', true).get()
            .then((snap) => ({ key: 'authorizations', snap }))
        );
      }
      if (scopes.personal) {
        fetches.push(
          db.collection('personalMaster').get()
            .then((snap) => ({ key: 'personal', snap }))
        );
      }
      if (scopes.vehicles) {
        fetches.push(
          db.collection('vehiclesMaster').get()
            .then((snap) => ({ key: 'vehicles', snap }))
        );
      }

      const results = await Promise.all(fetches);
      const byKey = Object.fromEntries(results.map((row) => [row.key, row.snap]));

      (byKey.authorizations?.docs || []).forEach((doc) => {
        const data = doc.data() || {};
        // Citaciones fuera. Permanent/visit solo con endDate real (no startDate).
        if (!shouldAlertAuthorizationExpiry(data)) return;
        const evaluated = evaluateExpiry(data.endDate, today);
        if (!evaluated) return;
        const subject = data.name || data.idNumber || 'autorización';
        pushAlert({
          id: `auth:${doc.id}`,
          kind: 'authorization',
          kindLabel: 'Autorización',
          subject,
          name: data.name || '',
          title: subject,
          message: buildExpiryMessage({
            kind: 'authorization',
            subject,
            endDate: evaluated.endDate,
            daysLeft: evaluated.daysLeft
          }),
          typeLabel: getAuthorizationLabel(data.type) || data.type || '',
          endDate: evaluated.endDate,
          daysLeft: evaluated.daysLeft,
          bucket: evaluated.bucket
        });
      });

      (byKey.personal?.docs || []).forEach((doc) => {
        const data = doc.data() || {};
        const subject = data.name || data.idNumberNormalized || data.idNumber || 'persona';
        [
          { key: 'artExpiryDate', kind: 'art' },
          { key: 'licenseExpiryDate', kind: 'license' }
        ].forEach(({ key, kind }) => {
          const evaluated = evaluateExpiry(data[key], today);
          if (!evaluated) return;
          pushAlert({
            id: `personal:${doc.id}:${kind}`,
            kind,
            kindLabel: kind === 'art' ? 'ART' : 'Licencia',
            subject,
            name: data.name || '',
            title: subject,
            message: buildExpiryMessage({
              kind,
              subject,
              endDate: evaluated.endDate,
              daysLeft: evaluated.daysLeft
            }),
            endDate: evaluated.endDate,
            daysLeft: evaluated.daysLeft,
            bucket: evaluated.bucket
          });
        });
      });

      (byKey.vehicles?.docs || []).forEach((doc) => {
        const data = doc.data() || {};
        const plate = data.plate || data.plateNormalized || 'vehículo';
        const subject = `la patente ${plate}`;
        [
          { key: 'insuranceExpiryDate', kind: 'insurance' },
          { key: 'vtvExpiryDate', kind: 'vtv' }
        ].forEach(({ key, kind }) => {
          const evaluated = evaluateExpiry(data[key], today);
          if (!evaluated) return;
          pushAlert({
            id: `vehicle:${doc.id}:${kind}`,
            kind,
            kindLabel: kind === 'insurance' ? 'Seguro' : 'VTV',
            subject: plate,
            name: plate,
            title: plate,
            message: buildExpiryMessage({
              kind,
              subject,
              endDate: evaluated.endDate,
              daysLeft: evaluated.daysLeft
            }),
            endDate: evaluated.endDate,
            daysLeft: evaluated.daysLeft,
            bucket: evaluated.bucket
          });
        });
      });

      const byPriority = (a, b) => {
        if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
        return String(a.endDate).localeCompare(String(b.endDate));
      };
      Object.keys(buckets).forEach((key) => buckets[key].sort(byPriority));

      res.json({
        today,
        scopes,
        expired: buckets.expired,
        endingIn7: buckets.endingIn7,
        endingIn15: buckets.endingIn15,
        endingIn30: buckets.endingIn30
      });
    } catch (err) {
      sendServerError(res, err, 'Error al obtener alertas de vencimiento');
    }
  }
);

module.exports = router;
