/**
 * API edge (Etapa 2, docs/ETAPA2-DISENO.md §3–§4, tarea T4 mínima para el Hito 1).
 *
 *   Admin (usuario):  GET/POST /api/admin/devices, POST /api/admin/devices/:id/{revoke,replace}
 *   Equipo (sin JWT): POST /api/edge/v1/enroll, POST /api/edge/v1/token
 *   Equipo (JWT de equipo, kind:'device'):
 *     GET  /api/edge/v1/head                       (hub y controlador)
 *     GET  /api/edge/v1/chunks?names=a,b           (hub)
 *     POST /api/edge/v1/events                     (hub)
 *     POST /api/edge/v1/heartbeat                  (hub y controlador)
 *     POST /api/edge/v1/commands/:id/result        (hub)
 *     POST /api/edge/v1/live                       (hub)
 *   Guardia (usuario): POST /api/guard/doors/:doorId/remote-open, GET /api/guard/commands/:id
 *   Vista remota:      GET /api/sites/:siteId/live (caché 15 s)
 *
 * Separación de tokens: el JWT de equipo no tiene `id` de usuario → el middleware `auth`
 * de las rutas de usuario lo rechaza; `deviceAuth` exige `kind:'device'` → rechaza usuarios.
 */

const express = require('express');
const { db, FieldValue } = require('../firestore');
const {
  auth,
  requirePermission,
  requireAnyPermission,
  userHasAnyPermission,
  verifyAuthToken,
  getJwtSecret,
  sendRouteError
} = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const { notifySafe } = require('../lib/notifications');
const { cachedGuardHandler } = require('../lib/guardResponseCache');
const {
  getClientIp,
  checkPairingRateLimit,
  recordPairingFailure
} = require('../lib/loginRateLimit');
const devices = require('../lib/devices');
const edge = require('../lib/edgeIngest');

const router = express.Router();

const FORCE_AIRLOCK_PERMISSION = 'puertas.estanco.forzar';
const MIN_FORCE_REASON_LENGTH = 5;

const actorOf = (req) => ({
  id: req.user?.id || null,
  username: req.user?.username || req.user?.id || null
});

const audit = (req, payload) => {
  logAdminAction({ req, ...payload }).catch((err) => console.error(`auditLog ${payload.action}:`, err.message));
};

/**
 * JWT de equipo. Rechaza tokens de usuario (sin kind:'device') y, si se pide, otros tipos de equipo.
 * @param {Array<'hub'|'controller'>} [kinds]
 */
const deviceAuth = (kinds = null) => (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Falta token de equipo', code: 'DEVICE_TOKEN_REQUIRED' });
  let secret;
  try {
    secret = getJwtSecret();
  } catch (_err) {
    return res.status(500).json({ message: 'Error de configuración del servidor' });
  }
  let payload;
  try {
    payload = verifyAuthToken(token, secret);
  } catch (_err) {
    return res.status(401).json({ message: 'Token no válido', code: 'DEVICE_TOKEN_INVALID' });
  }
  if (payload?.kind !== 'device' || !payload.sub || !payload.siteId || payload.id) {
    return res.status(401).json({ message: 'Se requiere token de equipo', code: 'DEVICE_TOKEN_REQUIRED' });
  }
  if (kinds && !kinds.includes(payload.deviceKind)) {
    return res.status(403).json({ message: 'Operación no permitida para este tipo de equipo', code: 'DEVICE_KIND_FORBIDDEN' });
  }
  req.device = { id: String(payload.sub), siteId: String(payload.siteId), kind: payload.deviceKind };
  return next();
};

const hubOnly = deviceAuth(['hub']);
const anyDevice = deviceAuth(['hub', 'controller']);

// ───────────────────────────── Admin: equipos ─────────────────────────────

router.get('/api/admin/devices', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const list = await devices.listDevices({ siteId: req.query.siteId || null });
    res.json({ devices: list });
  } catch (err) {
    sendRouteError(res, err, 'Error al listar equipos');
  }
});

router.post('/api/admin/devices', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const { siteId, kind, name, doorIds } = req.body || {};
    const result = await devices.createDevice({ siteId, kind, name, doorIds }, { createdBy: actorOf(req).username });
    audit(req, {
      action: 'device.create',
      targetType: 'device',
      targetId: result.device.id,
      before: null,
      after: { siteId: result.device.siteId, kind: result.device.kind, name: result.device.name, doorIds: result.device.doorIds }
    });
    res.status(201).json(result);
  } catch (err) {
    sendRouteError(res, err, 'Error al crear el equipo');
  }
});

router.post('/api/admin/devices/:id/revoke', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const { before, after } = await devices.revokeDevice(req.params.id, {
      by: actorOf(req).username,
      reason: req.body?.reason || null
    });
    audit(req, { action: 'device.revoke', targetType: 'device', targetId: after.id, before, after });
    res.json({ device: after });
  } catch (err) {
    sendRouteError(res, err, 'Error al revocar el equipo');
  }
});

router.post('/api/admin/devices/:id/replace', auth, requirePermission('lectores.manage'), async (req, res) => {
  try {
    const result = await devices.replaceDevice(req.params.id, {
      by: actorOf(req).username,
      name: req.body?.name || null
    });
    audit(req, {
      action: 'device.replace',
      targetType: 'device',
      targetId: req.params.id,
      before: { status: 'active' },
      after: { status: 'replaced', replacedBy: result.device.id }
    });
    res.status(201).json(result);
  } catch (err) {
    sendRouteError(res, err, 'Error al reemplazar el equipo');
  }
});

// ───────────────────────────── Enrolamiento y token ─────────────────────────────

router.post('/api/edge/v1/enroll', async (req, res) => {
  const ip = getClientIp(req);
  try {
    const limit = await checkPairingRateLimit(db, { ip });
    if (limit.blocked) {
      res.set('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({ message: limit.message, retryAfterSeconds: limit.retryAfterSeconds });
    }
    const { code, publicKey, kind, hostname } = req.body || {};
    const result = await devices.enrollDevice({ code, publicKey, kind, hostname });
    logAdminAction({
      actorId: result.deviceId,
      actorUsername: `device:${result.deviceId}`,
      action: 'device.enroll',
      targetType: 'device',
      targetId: result.deviceId,
      before: null,
      after: { siteId: result.siteId, kind: result.kind, hostname: hostname || null },
      req
    }).catch((err) => console.error('auditLog device.enroll:', err.message));
    return res.status(201).json({
      deviceId: result.deviceId,
      siteId: result.siteId,
      kind: result.kind,
      refreshToken: result.refreshToken
    });
  } catch (err) {
    if (err?.code === 'INVALID_CODE') {
      const limit = await recordPairingFailure(db, FieldValue, { ip }).catch(() => ({ blocked: false }));
      if (limit.blocked) {
        res.set('Retry-After', String(limit.retryAfterSeconds));
        return res.status(429).json({ message: limit.message, retryAfterSeconds: limit.retryAfterSeconds });
      }
    }
    return sendRouteError(res, err, 'Error al enrolar el equipo');
  }
});

router.post('/api/edge/v1/token', async (req, res) => {
  try {
    const result = await devices.exchangeDeviceToken(req.body || {});
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    sendRouteError(res, err, 'Error al emitir el token del equipo');
  }
});

// ───────────────────────────── Config ─────────────────────────────

router.get('/api/edge/v1/head', anyDevice, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await edge.readHead(req.device.siteId));
  } catch (err) {
    sendRouteError(res, err, 'Error al leer el head');
  }
});

router.get('/api/edge/v1/chunks', hubOnly, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await edge.readChunks(req.device.siteId, req.query.names));
  } catch (err) {
    sendRouteError(res, err, 'Error al leer chunks');
  }
});

// ───────────────────────────── Eventos y estado ─────────────────────────────

router.post('/api/edge/v1/events', hubOnly, async (req, res) => {
  try {
    const result = await edge.ingestEventBatch({
      siteId: req.device.siteId,
      hubId: req.device.id,
      body: req.body || {},
      notifySafe
    });
    res.json({ ackHubSeq: result.ackHubSeq, duplicate: result.duplicate, journalId: result.journalId });
  } catch (err) {
    sendRouteError(res, err, 'Error al registrar eventos');
  }
});

router.post('/api/edge/v1/heartbeat', anyDevice, async (req, res) => {
  try {
    res.json(await edge.recordHeartbeat({
      deviceId: req.device.id,
      siteId: req.device.siteId,
      deviceKind: req.device.kind,
      body: req.body || {}
    }));
  } catch (err) {
    sendRouteError(res, err, 'Error al registrar heartbeat');
  }
});

router.post('/api/edge/v1/live', hubOnly, async (req, res) => {
  try {
    res.json(await edge.writeLiveSummary({ siteId: req.device.siteId, hubId: req.device.id, body: req.body || {} }));
  } catch (err) {
    sendRouteError(res, err, 'Error al publicar el resumen en vivo');
  }
});

router.get('/api/sites/:siteId/live', auth, requireAnyPermission([
  'entries.view',
  'access.manual_open',
  'monitoring.doors.panel',
  'guard.doors.panel'
]), cachedGuardHandler(
  '/api/sites/live',
  async (req) => edge.readLiveSummary(devices.sanitizeSiteId(req.params.siteId)),
  {
    scope: (req) => String(req.params.siteId || ''),
    onError: (res, err) => sendRouteError(res, err, 'Error al leer el resumen en vivo')
  }
));

// ───────────────────────────── Comandos ─────────────────────────────

router.post('/api/guard/doors/:doorId/remote-open', auth, requirePermission('access.manual_open'), async (req, res) => {
  try {
    const { getDoorsConfig, findDoorById } = require('../lib/doorsConfig');
    const config = await getDoorsConfig();
    const door = findDoorById(config, String(req.params.doorId || ''));
    if (!door) return res.status(404).json({ message: 'Puerta no encontrada' });
    if (!door.controllerId) {
      return res.status(409).json({
        message: 'La puerta no está migrada a controlador local; usar la apertura actual.',
        code: 'DOOR_NOT_MIGRATED'
      });
    }
    // D4: forzar el estanco exige permiso + motivo (mismos parámetros que /api/guard/open-door).
    const forceAirlock = req.body?.forceAirlock === true;
    const forceReason = String(req.body?.forceReason || '').trim().slice(0, 500);
    if (forceAirlock) {
      if (!(await userHasAnyPermission(req, [FORCE_AIRLOCK_PERMISSION]))) {
        return res.status(403).json({ message: 'No tenés permiso para forzar la apertura del estanco.' });
      }
      if (forceReason.length < MIN_FORCE_REASON_LENGTH) {
        return res.status(400).json({ message: 'Indicá el motivo para forzar la apertura del estanco.' });
      }
    }
    const siteId = devices.sanitizeSiteId(door.siteId || devices.DEFAULT_SITE_ID);
    const command = await edge.createOpenCommand({
      siteId,
      door,
      requestedBy: actorOf(req),
      reason: forceAirlock ? `estanco_forzado: ${forceReason}` : (req.body?.reason || 'apertura_remota'),
      force: forceAirlock,
      forceReason
    });
    if (forceAirlock) {
      audit(req, {
        action: 'door.airlock.force_open',
        targetType: 'door',
        targetId: door.id,
        before: null,
        after: { forcedAirlock: true, reason: forceReason, doorName: door.name || null, commandId: command.id, via: 'edge' }
      });
    }
    res.status(202).json({ siteId, command });
  } catch (err) {
    sendRouteError(res, err, 'Error al encolar la apertura remota');
  }
});

router.get('/api/guard/commands/:id', auth, requirePermission('access.manual_open'), async (req, res) => {
  try {
    const siteId = devices.sanitizeSiteId(req.query.siteId || devices.DEFAULT_SITE_ID);
    res.set('Cache-Control', 'no-store');
    res.json({ siteId, command: await edge.getCommand({ siteId, id: req.params.id }) });
  } catch (err) {
    sendRouteError(res, err, 'Error al leer el comando');
  }
});

router.post('/api/edge/v1/commands/:id/result', hubOnly, async (req, res) => {
  try {
    const command = await edge.recordCommandResult({
      siteId: req.device.siteId,
      id: req.params.id,
      hubId: req.device.id,
      body: req.body || {}
    });
    res.json({ command });
  } catch (err) {
    sendRouteError(res, err, 'Error al registrar el resultado del comando');
  }
});

router.deviceAuth = deviceAuth;

module.exports = router;
