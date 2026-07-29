/**
 * Panel empleado: visitas propias + destinos de solo lectura.
 * Invitación pública por token (QR / WhatsApp / mail).
 * create = autorizada al instante; request = pendiente de aprobación admin.
 */

const crypto = require('crypto');
const express = require('express');
const { db, FieldValue, Timestamp } = require('../firestore');
const { auth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { normalizeDni } = require('../lib/normalize');
const { validateDestinationDoorIds } = require('../lib/empresasDestinos');
const { getDoorsConfig } = require('../lib/doorsConfig');
const { filterOwnVisitas } = require('../lib/visitasAccess');

const router = express.Router();

const newInviteToken = () => crypto.randomBytes(24).toString('hex');

const OPERATIVE_SHARE_ESTADOS = new Set(['pendiente', 'autorizada']);

const serializeVisita = (v) => ({
  ...v,
  createdAt: v.createdAt?.toDate ? v.createdAt.toDate().toISOString() : v.createdAt,
  fechaHoraEsperada: v.fechaHoraEsperada?.toDate
    ? v.fechaHoraEsperada.toDate().toISOString()
    : v.fechaHoraEsperada,
  aprobadoAt: v.aprobadoAt?.toDate ? v.aprobadoAt.toDate().toISOString() : v.aprobadoAt
});

const loadUserProfile = async (userId) => {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
};

const userDisplayName = (user) => {
  if (!user) return '';
  return String(user.nombre || user.name || user.username || user.email || user.id || '').trim();
};

/** Destinos activos (solo id/nombre) para el formulario de visitas. */
router.get(
  '/api/empleado/destinos',
  auth,
  requireAnyPermission(['visitas.create', 'visitas.request']),
  async (_req, res) => {
    try {
      const snap = await db.collection('destinos').orderBy('nombre').get();
      const destinos = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((d) => d.activo !== false)
        .map((d) => ({ id: d.id, nombre: d.nombre, doorIds: d.doorIds || [] }));
      res.json({ destinos });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al listar destinos' });
    }
  }
);

router.get('/api/empleado/visitas', auth, requirePermission('visitas.view.own'), async (req, res) => {
  try {
    const userId = req.user.id;
    let snap;
    try {
      snap = await db.collection('visitas')
        .where('createdByUserId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();
    } catch {
      snap = await db.collection('visitas')
        .where('createdByUserId', '==', userId)
        .limit(100)
        .get();
    }

    const visitas = filterOwnVisitas(
      snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      userId
    ).map(serializeVisita);

    res.json({ visitas });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al listar visitas' });
  }
});

router.post(
  '/api/empleado/visitas',
  auth,
  requireAnyPermission(['visitas.create', 'visitas.request']),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const permissions = Array.isArray(req.userPermissions) ? req.userPermissions : [];
      const isAdmin = req.user.role === 'admin';
      const canCreate = isAdmin || permissions.includes('visitas.create');
      const canRequest = isAdmin || permissions.includes('visitas.request');
      if (!canCreate && !canRequest) {
        return res.status(403).json({ message: 'Acceso denegado: permiso insuficiente' });
      }

      const user = await loadUserProfile(userId);
      const empresaId = user?.empresaId || null;
      if (!empresaId) {
        return res.status(400).json({ message: 'Tu usuario no tiene empresa asignada' });
      }

      let empresaNombre = '';
      try {
        const empSnap = await db.collection('empresas').doc(empresaId).get();
        if (empSnap.exists) {
          empresaNombre = String(empSnap.data()?.nombre || empSnap.data()?.name || '').trim();
        }
      } catch {
        // ignore
      }

      const createdByNombre = userDisplayName({ ...user, id: userId });
      const nombreVisitante = String(req.body?.nombreVisitante || '').trim();
      const dniVisitante = String(req.body?.dniVisitante || '').trim();
      const motivo = String(req.body?.motivo || '').trim();
      const destinoId = String(req.body?.destinoId || '').trim();
      const fechaHoraEsperadaRaw = req.body?.fechaHoraEsperada;

      if (!nombreVisitante || !dniVisitante || !destinoId || !fechaHoraEsperadaRaw) {
        return res.status(400).json({
          message: 'nombreVisitante, dniVisitante, destinoId y fechaHoraEsperada son obligatorios'
        });
      }

      const expected = new Date(fechaHoraEsperadaRaw);
      if (Number.isNaN(expected.getTime())) {
        return res.status(400).json({ message: 'fechaHoraEsperada inválida' });
      }

      const destSnap = await db.collection('destinos').doc(destinoId).get();
      if (!destSnap.exists || destSnap.data()?.activo === false) {
        return res.status(400).json({ message: 'Destino inválido o inactivo' });
      }
      const destino = destSnap.data();
      const doorsConfig = await getDoorsConfig();
      const allowedDoorIds = validateDestinationDoorIds(destino.doorIds || [], doorsConfig);

      const dniVisitanteNormalized = normalizeDni(dniVisitante);
      // create gana sobre request si tiene ambos
      const estado = canCreate ? 'autorizada' : 'pendiente_aprobacion';
      const inviteToken = canCreate ? newInviteToken() : null;
      const { normalizePhotoDataUrl } = require('../lib/personPhoto');
      let photoDataUrl = null;
      if (req.body?.photoDataUrl) {
        const photo = normalizePhotoDataUrl(req.body.photoDataUrl);
        if (!photo.ok) {
          return res.status(400).json({ message: photo.message });
        }
        photoDataUrl = photo.value;
      }
      const ref = db.collection('visitas').doc();
      const doc = {
        nombreVisitante,
        dniVisitante,
        dniVisitanteNormalized,
        fechaHoraEsperada: Timestamp.fromDate(expected),
        motivo,
        destinoId,
        destinoNombre: destino.nombre || '',
        allowedDoorIds,
        empresaId,
        empresaNombre,
        createdByUserId: userId,
        createdByNombre,
        inviteToken,
        estado,
        photoDataUrl,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      await ref.set(doc);

      res.status(201).json({
        message: canCreate
          ? 'Visita registrada y autorizada'
          : 'Solicitud de visita enviada. Queda pendiente de aprobación.',
        visita: {
          id: ref.id,
          ...doc,
          fechaHoraEsperada: expected.toISOString(),
          createdAt: new Date().toISOString()
        }
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message || 'Error al crear visita', code: err.code });
    }
  }
);

/** Asegura inviteToken en visitas operativas (solo dueño). */
router.post(
  '/api/empleado/visitas/:id/ensure-invite',
  auth,
  requireAnyPermission(['visitas.create', 'visitas.request']),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const ref = db.collection('visitas').doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Visita no encontrada' });
      }
      const data = snap.data() || {};
      if (data.createdByUserId !== userId) {
        return res.status(403).json({ message: 'No podés compartir esta visita' });
      }
      if (!OPERATIVE_SHARE_ESTADOS.has(data.estado || 'pendiente')) {
        return res.status(400).json({
          message: 'La visita aún no está autorizada. Cuando un admin la apruebe vas a poder compartir el QR.'
        });
      }
      let inviteToken = data.inviteToken;
      if (!inviteToken) {
        inviteToken = newInviteToken();
        await ref.set({ inviteToken, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      res.json({
        inviteToken,
        visita: serializeVisita({ id: snap.id, ...data, inviteToken })
      });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al preparar invitación' });
    }
  }
);

/**
 * Vista pública de invitación (sin login).
 * El token es el secreto; no listar visitas sin él.
 */
router.get('/api/public/visita-invite/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 16) {
      return res.status(400).json({ message: 'Token inválido' });
    }
    const snap = await db.collection('visitas')
      .where('inviteToken', '==', token)
      .limit(1)
      .get();
    if (snap.empty) {
      return res.status(404).json({ message: 'Invitación no encontrada o vencida' });
    }
    const doc = snap.docs[0];
    const v = serializeVisita({ id: doc.id, ...doc.data() });
    if (!OPERATIVE_SHARE_ESTADOS.has(v.estado || 'pendiente')) {
      return res.status(404).json({ message: 'Invitación no disponible' });
    }
    res.json({
      invite: {
        id: v.id,
        nombreVisitante: v.nombreVisitante,
        dniVisitante: v.dniVisitanteNormalized || v.dniVisitante,
        dniVisitanteNormalized: v.dniVisitanteNormalized || normalizeDni(v.dniVisitante),
        destinoNombre: v.destinoNombre || '',
        fechaHoraEsperada: v.fechaHoraEsperada,
        motivo: v.motivo || '',
        estado: v.estado || 'pendiente'
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al cargar invitación' });
  }
});

module.exports = router;
