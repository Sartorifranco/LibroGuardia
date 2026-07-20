/**
 * Funcionalidad transversal de sistema / gerencial:
 * búsqueda global, actividad, auditoría, reportes, notificaciones, alertas de vencimiento.
 */

const express = require('express');
const { db } = require('../firestore');
const { normalizeIdNumber, normalizePlate } = require('../permissions');
const { getAuthorizationLabel } = require('../authorizations');
const { listAuditLog } = require('../lib/auditLog');
const { getArgentinaDateString } = require('../lib/normalize');
const { buildReportsSummary, REPORTS_PERMISSION } = require('../reports');
const {
  getNotificationsConfig,
  publicNotificationsConfig,
  saveNotificationsConfig
} = require('../lib/notifications');
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
  getUserPermissions
} = require('../middleware/auth');

const router = express.Router();

const addDaysToYmd = (ymd, days) => {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  d.setDate(d.getDate() + days);
  return getArgentinaDateString(d);
};

router.get('/api/search', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ results: [] });
    }
    const needle = q.toLowerCase();
    const idNeedle = normalizeIdNumber(q) || needle;
    const plateNeedle = normalizePlate(q) || needle.replace(/\s+/g, '');
    const results = [];

    const personalSnap = await db.collection('personalMaster').orderBy('name').limit(200).get();
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

    const vehiclesSnap = await db.collection('vehiclesMaster').orderBy('plate').limit(200).get();
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
    const page = await queryEntriesPage(db, {
      startDate,
      endDate,
      limit: 80,
      type: 'todos',
      q
    });
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
    res.status(500).json({ message: 'Error en la búsqueda', error: err.message });
  }
});

router.get(
  '/api/admin/activity',
  auth,
  requireAnyPermission(['users.view', 'roles.view', 'settings.permissions']),
  async (req, res) => {
    try {
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.floor(limitRaw), 1), 100)
        : 50;
      const snap = await db.collection('activityLog')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      const activity = snap.docs.map((doc) => {
        const data = doc.data() || {};
        let createdAt = data.createdAt || null;
        if (createdAt && typeof createdAt.toDate === 'function') {
          createdAt = createdAt.toDate().toISOString();
        }
        return {
          id: doc.id,
          actorUsername: data.actorUsername || '',
          actorId: data.actorId || '',
          action: data.action || '',
          summary: data.summary || '',
          meta: data.meta || null,
          createdAt
        };
      });
      res.json({ activity });
    } catch (err) {
      res.status(500).json({ message: 'Error al obtener actividad', error: err.message });
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
    res.status(500).json({ message: 'Error al obtener auditoría', error: err.message });
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
    res.status(status).json({
      message: err.message || 'Error al generar el resumen de reportes',
      ...(status === 500 ? { error: err.message } : {})
    });
  }
});

router.get('/api/admin/notifications-config', auth, requirePermission('notifications.config'), async (_req, res) => {
  try {
    const config = await getNotificationsConfig();
    res.json({ config: publicNotificationsConfig(config) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener notificaciones', error: err.message });
  }
});

router.put('/api/admin/notifications-config', auth, requirePermission('notifications.config'), async (req, res) => {
  try {
    const saved = await saveNotificationsConfig(req.body || {});
    res.json({
      message: 'Configuración de notificaciones guardada',
      config: publicNotificationsConfig(saved)
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar notificaciones', error: err.message });
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
      res.status(500).json({ message: 'Error al obtener alertas de vencimiento', error: err.message });
    }
  }
);

module.exports = router;
