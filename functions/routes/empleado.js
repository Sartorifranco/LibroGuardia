/**
 * Panel empleado: visitas propias + destinos de solo lectura.
 */

const express = require('express');
const { db, FieldValue, Timestamp } = require('../firestore');
const { auth, requirePermission } = require('../middleware/auth');
const { normalizeDni } = require('../lib/normalize');
const { validateDestinationDoorIds } = require('../lib/empresasDestinos');
const { getDoorsConfig } = require('../lib/doorsConfig');
const { filterOwnVisitas } = require('../lib/visitasAccess');

const router = express.Router();

const getEmpresaIdFromUser = async (userId) => {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return null;
  return snap.data()?.empresaId || null;
};

/** Destinos activos (solo id/nombre) para el formulario de visitas. */
router.get('/api/empleado/destinos', auth, requirePermission('visitas.create'), async (_req, res) => {
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
});

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
    ).map((v) => ({
      ...v,
      createdAt: v.createdAt?.toDate ? v.createdAt.toDate().toISOString() : v.createdAt,
      fechaHoraEsperada: v.fechaHoraEsperada?.toDate
        ? v.fechaHoraEsperada.toDate().toISOString()
        : v.fechaHoraEsperada
    }));

    res.json({ visitas });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al listar visitas' });
  }
});

router.post('/api/empleado/visitas', auth, requirePermission('visitas.create'), async (req, res) => {
  try {
    const userId = req.user.id;
    const empresaId = await getEmpresaIdFromUser(userId);
    if (!empresaId) {
      return res.status(400).json({ message: 'Tu usuario no tiene empresa asignada' });
    }

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
    // Snapshot de puertas del destino al crear (no referencia viva)
    const allowedDoorIds = validateDestinationDoorIds(destino.doorIds || [], doorsConfig);

    const dniVisitanteNormalized = normalizeDni(dniVisitante);
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
      createdByUserId: userId,
      // Ignorar cualquier empresaId/createdByUserId del body
      estado: 'pendiente',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await ref.set(doc);

    res.status(201).json({
      message: 'Visita registrada',
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
});

module.exports = router;
