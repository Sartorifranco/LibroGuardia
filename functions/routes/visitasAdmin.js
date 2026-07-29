/**
 * Admin: aprobar / rechazar solicitudes de visita (visitas.request).
 */

const crypto = require('crypto');
const express = require('express');
const { db, FieldValue } = require('../firestore');
const { auth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { logAdminAction } = require('../lib/auditLog');

const router = express.Router();

const newInviteToken = () => crypto.randomBytes(24).toString('hex');

const serializeVisita = (v) => ({
  ...v,
  createdAt: v.createdAt?.toDate ? v.createdAt.toDate().toISOString() : v.createdAt,
  fechaHoraEsperada: v.fechaHoraEsperada?.toDate
    ? v.fechaHoraEsperada.toDate().toISOString()
    : v.fechaHoraEsperada,
  aprobadoAt: v.aprobadoAt?.toDate ? v.aprobadoAt.toDate().toISOString() : v.aprobadoAt
});

const actorLabel = (user) => String(
  user?.nombre || user?.username || user?.email || user?.id || ''
).trim();

router.get('/api/admin/visitas/pending', auth, requirePermission('visitas.approve'), async (_req, res) => {
  try {
    let snap;
    try {
      snap = await db.collection('visitas')
        .where('estado', '==', 'pendiente_aprobacion')
        .limit(200)
        .get();
    } catch {
      snap = await db.collection('visitas').orderBy('createdAt', 'desc').limit(200).get();
    }
    const visitas = snap.docs
      .map((d) => serializeVisita({ id: d.id, ...d.data() }))
      .filter((v) => v.estado === 'pendiente_aprobacion')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ visitas });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al listar solicitudes' });
  }
});

router.post('/api/admin/visitas/:id/approve', auth, requirePermission('visitas.approve'), async (req, res) => {
  try {
    const ref = db.collection('visitas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Visita no encontrada' });
    }
    const data = snap.data() || {};
    if (data.estado !== 'pendiente_aprobacion') {
      return res.status(400).json({ message: 'Esta visita no está pendiente de aprobación' });
    }
    const inviteToken = data.inviteToken || newInviteToken();
    const aprobadoPor = actorLabel(req.user);
    await ref.set({
      estado: 'autorizada',
      inviteToken,
      aprobadoPor,
      aprobadoPorUserId: req.user.id,
      aprobadoAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const updated = await ref.get();
    const visita = serializeVisita({ id: updated.id, ...updated.data() });
    const summary = `${aprobadoPor} aprobó la visita de “${data.nombreVisitante || data.dniVisitante || req.params.id}”`;
    logActivity(db, FieldValue, {
      actorUsername: req.user.username || req.user.id,
      actorId: req.user.id,
      action: 'visita.approve',
      summary,
      meta: { visitaId: req.params.id }
    }).catch((err) => console.error('activityLog visita.approve:', err.message));
    logAdminAction({
      req,
      action: 'visita.approve',
      targetType: 'visita',
      targetId: req.params.id,
      before: { estado: data.estado },
      after: { estado: 'autorizada', nombreVisitante: data.nombreVisitante }
    }).catch((err) => console.error('auditLog visita.approve:', err.message));

    res.json({ message: 'Visita aprobada', visita });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al aprobar visita' });
  }
});

router.post('/api/admin/visitas/:id/reject', auth, requirePermission('visitas.approve'), async (req, res) => {
  try {
    const ref = db.collection('visitas').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Visita no encontrada' });
    }
    const data = snap.data() || {};
    if (data.estado !== 'pendiente_aprobacion') {
      return res.status(400).json({ message: 'Esta visita no está pendiente de aprobación' });
    }
    const motivoRechazo = String(req.body?.motivo || '').trim();
    const aprobadoPor = actorLabel(req.user);
    await ref.set({
      estado: 'rechazada',
      rechazadaPor: aprobadoPor,
      rechazadaPorUserId: req.user.id,
      motivoRechazo,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const updated = await ref.get();
    const summary = `${aprobadoPor} rechazó la visita de “${data.nombreVisitante || data.dniVisitante || req.params.id}”`;
    logActivity(db, FieldValue, {
      actorUsername: req.user.username || req.user.id,
      actorId: req.user.id,
      action: 'visita.reject',
      summary,
      meta: { visitaId: req.params.id }
    }).catch((err) => console.error('activityLog visita.reject:', err.message));
    logAdminAction({
      req,
      action: 'visita.reject',
      targetType: 'visita',
      targetId: req.params.id,
      before: { estado: data.estado },
      after: { estado: 'rechazada', motivoRechazo }
    }).catch((err) => console.error('auditLog visita.reject:', err.message));

    res.json({
      message: 'Visita rechazada',
      visita: serializeVisita({ id: updated.id, ...updated.data() })
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al rechazar visita' });
  }
});

module.exports = router;
