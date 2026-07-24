/**
 * CRUD admin de estaciones de hardware (multi-lector + servidor LAN).
 */

const express = require('express');
const { auth, requirePermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const { resolveApiBaseUrl } = require('../lib/lectores');
const {
  listEstaciones,
  getEstacionById,
  createEstacion,
  updateEstacion,
  deleteEstacion,
  listLectoresDeEstacion,
  setLectoresDeEstacion,
  buildStationConfigForDownload
} = require('../lib/estaciones');

const router = express.Router();

router.get('/api/admin/estaciones', auth, requirePermission('lectores.manage'), async (_req, res) => {
  try {
    const estaciones = await listEstaciones();
    const withCounts = await Promise.all(estaciones.map(async (e) => {
      const lectores = await listLectoresDeEstacion(e.id);
      return { ...e, lectoresCount: lectores.length, lectorIds: lectores.map((l) => l.id) };
    }));
    res.json({ estaciones: withCounts });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al listar estaciones' });
  }
});

router.get('/api/admin/estaciones/:id', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const estacion = await getEstacionById(req.params.id);
    const lectores = await listLectoresDeEstacion(estacion.id);
    res.json({
      estacion: {
        ...estacion,
        lectoresCount: lectores.length,
        lectorIds: lectores.map((l) => l.id)
      },
      lectores
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al obtener estación' });
  }
});

router.post('/api/admin/estaciones', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const estacion = await createEstacion(req.body || {});
    logAdminAction({
      req,
      action: 'estacion.create',
      targetType: 'estacion',
      targetId: estacion.id,
      after: { ...estacion, secretoLocal: '[redacted]' }
    }).catch(() => {});
    res.status(201).json({
      message: 'Estación creada. Guardá el secreto local: va en el JSON de la mini PC.',
      estacion
    });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al crear estación',
      code: err.code
    });
  }
});

router.put('/api/admin/estaciones/:id', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const { before, estacion } = await updateEstacion(req.params.id, req.body || {});
    logAdminAction({
      req,
      action: 'estacion.update',
      targetType: 'estacion',
      targetId: estacion.id,
      before: { ...before, secretoLocal: '[redacted]' },
      after: { ...estacion, secretoLocal: '[redacted]' }
    }).catch(() => {});
    res.json({ message: 'Estación actualizada', estacion });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al actualizar estación',
      code: err.code
    });
  }
});

router.delete('/api/admin/estaciones/:id', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const before = await deleteEstacion(req.params.id);
    logAdminAction({
      req,
      action: 'estacion.delete',
      targetType: 'estacion',
      targetId: before.id,
      before: { ...before, secretoLocal: '[redacted]' }
    }).catch(() => {});
    res.json({ message: 'Estación eliminada (lectores desasociados)', id: before.id });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al eliminar estación' });
  }
});

/**
 * Reemplaza la lista de lectores asociados a la estación.
 * Body: { lectorIds: string[] }
 */
router.put(
  '/api/admin/estaciones/:id/lectores',
  auth,
  requirePermission('lectores.manage'),
  async (req, res) => {
    try {
      const lectores = await setLectoresDeEstacion(
        req.params.id,
        req.body?.lectorIds || req.body?.lectores || []
      );
      logAdminAction({
        req,
        action: 'estacion.assign_lectores',
        targetType: 'estacion',
        targetId: req.params.id,
        after: { lectorIds: lectores.map((l) => l.id) }
      }).catch(() => {});
      res.json({
        message: 'Lectores de la estación actualizados',
        lectores,
        lectorIds: lectores.map((l) => l.id)
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al asignar lectores',
        code: err.code
      });
    }
  }
);

/**
 * JSON unificado (apiBaseUrl + readers[] + localServer*) para la estación.
 * Passwords de kiosk vacíos (igual que download individual); secretoLocal sí incluido.
 */
router.get(
  '/api/admin/estaciones/:id/config',
  auth,
  requirePermission('lectores.manage'),
  async (req, res) => {
    try {
      const apiBaseUrl = resolveApiBaseUrl(req);
      const config = await buildStationConfigForDownload(req.params.id, { apiBaseUrl });
      res.json({
        message: config.readers.length
          ? 'Config de estación lista. Las contraseñas de kiosk van vacías: usá Regenerar en cada lector si las perdiste.'
          : 'Config de estación sin lectores asociados. Asigná lectores antes de instalar.',
        config
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message || 'Error al armar config de estación' });
    }
  }
);

module.exports = router;
