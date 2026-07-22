/**
 * CRUD admin de lectores físicos + heartbeat del door-reader-bridge.
 *
 * Router propio (mismo criterio que empresasDestinos.js): dominio de
 * infraestructura de campo, no mezclar con access.js (control de acceso /
 * hardware SR201) ni masterData.
 */

const express = require('express');
const { auth, requirePermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const {
  listLectores,
  createLector,
  updateLector,
  deleteLector,
  regenerateCredentials,
  buildConfigForDownload,
  touchHeartbeat,
  resolveApiBaseUrl,
  resolveConnectionStatus
} = require('../lib/lectores');

const router = express.Router();

router.get('/api/admin/lectores', auth, requirePermission('lectores.manage'), async (_req, res) => {
  try {
    const lectores = await listLectores();
    const now = Date.now();
    res.json({
      lectores: lectores.map((l) => ({
        ...l,
        connectionStatus: resolveConnectionStatus(l.ultimaConexion, now)
      }))
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al listar lectores' });
  }
});

router.post('/api/admin/lectores', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const apiBaseUrl = resolveApiBaseUrl(req);
    const result = await createLector(req.body || {}, { apiBaseUrl });
    logAdminAction({
      req,
      action: 'lector.create',
      targetType: 'lector',
      targetId: result.lector.id,
      after: { ...result.lector, usuarioSistemaId: result.username }
    }).catch(() => {});
    res.status(201).json({
      message: 'Lector creado. Guardá la contraseña: no se volverá a mostrar.',
      lector: {
        ...result.lector,
        connectionStatus: 'offline'
      },
      password: result.password,
      config: result.config
    });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al crear lector',
      code: err.code
    });
  }
});

router.put('/api/admin/lectores/:id', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const { before, lector } = await updateLector(req.params.id, req.body || {});
    logAdminAction({
      req,
      action: 'lector.update',
      targetType: 'lector',
      targetId: lector.id,
      before,
      after: lector
    }).catch(() => {});
    res.json({
      message: 'Lector actualizado. Si cambiaste puerta/readerId, actualizá el JSON en la mini PC.',
      lector: {
        ...lector,
        connectionStatus: resolveConnectionStatus(lector.ultimaConexion)
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al actualizar lector',
      code: err.code
    });
  }
});

router.delete('/api/admin/lectores/:id', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const before = await deleteLector(req.params.id);
    logAdminAction({
      req,
      action: 'lector.delete',
      targetType: 'lector',
      targetId: before.id,
      before
    }).catch(() => {});
    res.json({ message: 'Lector y usuario de sistema eliminados', id: before.id });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al eliminar lector' });
  }
});

router.post(
  '/api/admin/lectores/:id/regenerate-credentials',
  auth,
  requirePermission('lectores.manage'),
  async (req, res) => {
    try {
      const apiBaseUrl = resolveApiBaseUrl(req);
      const result = await regenerateCredentials(req.params.id, { apiBaseUrl });
      logAdminAction({
        req,
        action: 'lector.regenerate_credentials',
        targetType: 'lector',
        targetId: result.lector.id,
        after: { usuarioSistemaId: result.lector.usuarioSistemaId }
      }).catch(() => {});
      res.json({
        message: 'Credenciales regeneradas. La contraseña anterior ya no sirve. Guardá la nueva: no se volverá a mostrar.',
        lector: result.lector,
        password: result.password,
        config: result.config
      });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message || 'Error al regenerar credenciales' });
    }
  }
);

/** Config sin password (para re-descarga). Password solo en create/regenerate. */
router.get('/api/admin/lectores/:id/config', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const apiBaseUrl = resolveApiBaseUrl(req);
    const config = await buildConfigForDownload(req.params.id, { apiBaseUrl, includePassword: false });
    res.json({
      message: 'Config sin contraseña. Si la perdiste, usá Regenerar credenciales.',
      config
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al armar config' });
  }
});

/**
 * Heartbeat del door-reader-bridge (usuario kiosk).
 * Solo actualiza ultimaConexion — sin disparar relé ni parsear lecturas.
 */
router.post('/api/lectores/heartbeat', auth, async (req, res) => {
  try {
    const username = req.user?.id || req.user?.username;
    const lector = await touchHeartbeat({
      username,
      lectorId: req.body?.lectorId || null,
      doorId: req.body?.doorId || null,
      readerId: req.body?.readerId || null
    });
    res.json({
      ok: true,
      lectorId: lector.id,
      ultimaConexion: lector.ultimaConexion,
      connectionStatus: resolveConnectionStatus(lector.ultimaConexion)
    });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error en heartbeat',
      code: err.code
    });
  }
});

module.exports = router;
