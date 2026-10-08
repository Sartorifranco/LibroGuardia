const express = require('express');
const { markDirty } = require('../lib/siteCompiler');
const { db } = require('../firestore');
const { parseScanData, normalizeIdNumber } = require('../permissions');
const { resolveAuthorization } = require('../authorizations');
const {
  DEFAULT_ACCESS_CONTROL,
  getAccessControlConfig,
  saveGlobalAccessSettings
} = require('../lib/accessControlStore');
const {
  getDoorsConfig,
  saveDoorsConfig,
  AUTH_METHODS,
  getDoorsConfigMeta
} = require('../lib/doorsConfig');
const {
  openDoor,
  listActiveDoors,
  getAirlockState,
  resetAirlockState,
  getDoorsPhysicalStatus
} = require('../doorController');
const {
  evaluatePersonalAccess,
  manualOpenDoor,
  processKioskScan,
  validarAcceso
} = require('../accessControl');
const { normalizeAccessIngestRequest } = require('../lib/accessIngest');
const {
  ACCESS_HARDWARE_BRANDS,
  ACCESS_COMMERCIAL_PROFILES
} = require('../lib/accessHardwareBrands');
const { ACTUATOR_TEMPLATES } = require('../lib/actuatorTemplates');
const { resolveDoorAllowlist } = require('../lib/allowlistCache');
const { ingestOfflineEntries } = require('../lib/offlineEntries');
const {
  checkAccessStatus,
  preRegisterVisitor,
  registerExceptionalEntry
} = require('../guard');
const { logAdminAction } = require('../lib/auditLog');
const { notifySafe } = require('../lib/notifications');
const {
  maskDoors,
  maskDoorsConfig,
  maskAccessControlConfig,
  restoreDoorSecrets,
  restoreAccessControlSecret
} = require('../lib/secretMask');
const {
  auth,
  requirePermission,
  requireAnyPermission,
  userHasAnyPermission,
  sendServerError,
  sendRouteError
} = require('../middleware/auth');
const { resolveAuthUsername } = require('../lib/lectores');
const { cachedGuardHandler, invalidateGuardCache } = require('../lib/guardResponseCache');

const router = express.Router();

// Después de abrir una puerta, el panel de este mismo servidor ve el pulso nuevo al instante.
router.use('/api/guard/open-door', (req, res, next) => {
  res.on('finish', () => invalidateGuardCache('/api/guard/doors'));
  next();
});

const buildResolvedName = (parsed) => {
  if (parsed.name) return parsed.name;
  return [parsed.firstName, parsed.lastName].filter(Boolean).join(' ').trim();
};

router.get('/api/admin/access-control', auth, requirePermission('access.control'), async (_req, res) => {
  try {
    const config = await getAccessControlConfig();
    res.json({ config: maskAccessControlConfig(config) });
  } catch (err) {
    sendServerError(res, err, 'Error al obtener configuración de acceso');
  }
});

router.put('/api/admin/access-control', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const allowedKeys = Object.keys(DEFAULT_ACCESS_CONTROL);
    const before = await getAccessControlConfig();
    const body = restoreAccessControlSecret(req.body || {}, before);
    const updates = {};
    allowedKeys.forEach((key) => {
      if (body[key] !== undefined) updates[key] = body[key];
    });

    await db.collection('settings').doc('accessControl').set(updates, { merge: true });
    const config = await getAccessControlConfig();
    res.json({ message: 'Configuración de acceso actualizada', config: maskAccessControlConfig(config) });
  } catch (err) {
    sendServerError(res, err, 'Error al guardar configuración de acceso');
  }
});

router.post('/api/access/test-relay', auth, requireAnyPermission(['access.control', 'access.doors.manage']), async (req, res) => {
  try {
    const doorsConfig = await getDoorsConfig();
    const doorId = req.body?.doorId || doorsConfig.defaultDoorId || doorsConfig.doors?.[0]?.id;
    if (!doorId) {
      return res.status(400).json({ message: 'No hay puertas configuradas para probar' });
    }
    const pulseSeconds = req.body?.pulseSeconds != null ? Number(req.body.pulseSeconds) : null;
    const pulseMode = req.body?.pulseMode || (pulseSeconds ? 'timed' : null);
    const result = await openDoor({
      doorId,
      username: req.user?.username,
      // El pulso de prueba abre la puerta de verdad: respeta el estanco como cualquier apertura manual.
      manual: true,
      force: true,
      reason: 'test_relay',
      pulseSeconds: Number.isFinite(pulseSeconds) && pulseSeconds > 0 ? pulseSeconds : null,
      pulseMode
    });
    const secs = result.relay?.seconds || pulseSeconds;
    res.json({
      message: secs
        ? `Pulso de prueba enviado (${secs}s)`
        : 'Pulso de prueba enviado',
      ...result
    });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al probar relevador SR201',
      error: err.message
    });
  }
});

const FORCE_AIRLOCK_PERMISSION = 'puertas.estanco.forzar';
const MIN_FORCE_REASON_LENGTH = 5;

router.post('/api/guard/open-door', auth, requirePermission('access.manual_open'), async (req, res) => {
  try {
    // bypassAirlock del body ya no se acepta: la apertura manual respeta el estanco.
    // Forzar requiere permiso puertas.estanco.forzar + motivo, y queda auditado.
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
    const result = await manualOpenDoor({
      username: req.user?.username || req.user?.id,
      userId: req.user?.id || null,
      reason: forceAirlock
        ? `estanco_forzado: ${forceReason}`
        : (req.body?.reason || 'apertura_manual_guardia'),
      doorId: req.body?.doorId || null,
      forceAirlock
    });
    if (result?.forcedAirlock) {
      logAdminAction({
        req,
        action: 'door.airlock.force_open',
        targetType: 'door',
        targetId: result.door?.id || req.body?.doorId || null,
        before: null,
        after: {
          forcedAirlock: true,
          reason: forceReason,
          doorName: result.door?.name || null,
          airlockGroupId: result.airlock?.groupId || null,
          phaseBefore: result.forcedAirlock.phase || null,
          otherDoorName: result.forcedAirlock.otherDoorName || null
        }
      }).catch((err) => console.error('auditLog door.airlock.force_open:', err.message));
    }
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al abrir la puerta',
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      airlock: err.airlock || undefined
    });
  }
});

// Caché de 15 s por instancia: la respuesta no depende del usuario (mismo enmascarado para todos).
router.get('/api/guard/doors', auth, requirePermission('access.manual_open'), cachedGuardHandler(
  '/api/guard/doors',
  async () => {
    const { enrichDoorsWithLastPulse } = require('../lib/doorLastPulse');
    const { enrichDoorsWithLocalStations } = require('../lib/guardLocalStations');
    const base = await listActiveDoors();
    const withPulse = await enrichDoorsWithLastPulse(base.doors || []);
    const doors = await enrichDoorsWithLocalStations(withPulse);
    // Guardias no necesitan secretos del hardware.
    return { ...base, doors: maskDoors(doors) };
  },
  { onError: (res, err) => sendServerError(res, err) }
));

router.get('/api/guard/door-names', auth, requireAnyPermission(['entries.view', 'reports.export', 'access.manual_open', 'access.doors.manage']), async (_req, res) => {
  try {
    const config = await getDoorsConfig();
    res.json({
      doors: (config.doors || []).map((d) => ({
        id: d.id,
        name: d.name || d.id,
        active: d.active !== false
      }))
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/api/guard/live-alerts', auth, requireAnyPermission(['entries.view', 'entries.create', 'access.kiosk', 'access.manual_open', 'attendance.alerts.read']), cachedGuardHandler(
  '/api/guard/live-alerts',
  async () => {
    const { getLiveAlerts } = require('../lib/liveAlerts');
    return getLiveAlerts();
  },
  { onError: (res, err) => sendServerError(res, err, 'Error al obtener alertas en vivo') }
));

router.get('/api/guard/fleet-presence', auth, requireAnyPermission(['entries.view', 'entries.create', 'fleet.gps.read']), cachedGuardHandler(
  '/api/guard/fleet-presence',
  async () => {
    const { getFleetPresence } = require('../lib/getFleetPresence');
    return getFleetPresence();
  },
  { onError: (res, err) => sendServerError(res, err, 'Error al calcular presencia de flota') }
));

router.get('/api/admin/doors-config', auth, requireAnyPermission(['access.doors.manage', 'access.control']), async (_req, res) => {
  try {
    const { enrichDoorsWithLocalStations } = require('../lib/guardLocalStations');
    const [config, globalAccess, meta] = await Promise.all([
      getDoorsConfig(),
      getAccessControlConfig(),
      getDoorsConfigMeta()
    ]);
    const doors = await enrichDoorsWithLocalStations(config.doors || []);
    // Secretos enmascarados ("••••" + 2 últimos) + hasBridgeSecret/hasHttpAuthToken.
    res.json({
      config: maskDoorsConfig({ ...config, doors }),
      globalAccess: maskAccessControlConfig(globalAccess),
      authMethods: AUTH_METHODS,
      meta: {
        ...meta,
        legacyFallback: !meta.hasStoredDoors
      }
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/api/admin/doors/physical-status', auth, requireAnyPermission(['access.doors.manage', 'access.control', 'access.manual_open']), async (_req, res) => {
  try {
    const result = await getDoorsPhysicalStatus();
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al leer estado físico' });
  }
});

router.put('/api/admin/doors-config', auth, requireAnyPermission(['access.doors.manage', 'access.control']), async (req, res) => {
  try {
    const before = await getDoorsConfig();
    const { globalAccess: rawGlobalAccess, ...doorsPayload } = req.body || {};
    // Si el admin guarda sin tocar el secreto, llega la máscara (o vacío): conservar el guardado.
    if (Array.isArray(doorsPayload.doors)) {
      doorsPayload.doors = restoreDoorSecrets(doorsPayload.doors, before.doors || []);
    }
    const globalAccess = rawGlobalAccess && typeof rawGlobalAccess === 'object'
      ? restoreAccessControlSecret(rawGlobalAccess, await getAccessControlConfig())
      : rawGlobalAccess;
    if (Array.isArray(doorsPayload.doors)) {
      const { assertDoorsCompatibleWithOfflineLectores } = require('../lib/accessHardwareCoherence');
      const { listLectores } = require('../lib/lectores');
      await assertDoorsCompatibleWithOfflineLectores(doorsPayload.doors, listLectores);
    }
    const config = await saveDoorsConfig(doorsPayload);
    markDirty({ doors: true });
    let savedGlobalAccess = null;
    if (globalAccess && typeof globalAccess === 'object') {
      savedGlobalAccess = await saveGlobalAccessSettings(globalAccess);
    }
    logAdminAction({
      req,
      action: 'door.config.update',
      targetType: 'doors_config',
      targetId: 'doorsConfig',
      before: {
        doors: maskDoors(before.doors),
        airlockGroups: before.airlockGroups,
        defaultDoorId: before.defaultDoorId
      },
      after: {
        doors: maskDoors(config.doors),
        airlockGroups: config.airlockGroups,
        defaultDoorId: config.defaultDoorId,
        globalAccessUpdated: Boolean(savedGlobalAccess)
      }
    }).catch((err) => console.error('auditLog door.config.update:', err.message));
    res.json({
      message: 'Configuración de puertas y acceso guardada',
      config: maskDoorsConfig(config),
      globalAccess: maskAccessControlConfig(savedGlobalAccess || await getAccessControlConfig())
    });
  } catch (err) {
    sendRouteError(res, err, 'Error al guardar puertas');
  }
});

router.get('/api/guard/airlock/:groupId', auth, requirePermission('access.manual_open'), async (req, res) => {
  try {
    res.json({ state: await getAirlockState(req.params.groupId) });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/api/guard/airlock/:groupId/reset', auth, requirePermission('access.doors.manage'), async (req, res) => {
  try {
    await resetAirlockState(req.params.groupId, req.body?.reason || 'manual_reset');
    res.json({ message: 'Estanco reiniciado', state: await getAirlockState(req.params.groupId) });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/api/access/validar', auth, requireAnyPermission(['access.kiosk', 'entries.create']), async (req, res) => {
  try {
    const {
      dni = '',
      nombre = '',
      apellido = '',
      tipoMovimiento = 'ingreso',
      channel = 'molinete',
      guardId = null
    } = req.body;

    const result = await validarAcceso({
      dni,
      nombre,
      apellido,
      tipoMovimiento,
      channel,
      guardId: guardId || req.user?.id || null
    });

    res.json(result);
  } catch (err) {
    sendServerError(res, err, 'Error al validar acceso');
  }
});

router.get('/api/guard/access-status', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const result = await checkAccessStatus({
      dni: req.query.dni || req.query.idNumber || '',
      name: req.query.name || ''
    });
    res.json(result);
  } catch (err) {
    sendServerError(res, err, 'Error al consultar acceso');
  }
});

router.post('/api/guard/pre-register', auth, requirePermission('master.citaciones.preregister'), async (req, res) => {
  try {
    const authorization = await preRegisterVisitor(req.body, {
      userId: req.user.id,
      username: req.user.username
    });
    res.status(201).json({ message: 'Visita pre-registrada', authorization });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Error al pre-registrar' });
  }
});

router.post('/api/guard/exceptional-entry', auth, requirePermission('access.exceptional_entry'), async (req, res) => {
  try {
    const result = await registerExceptionalEntry(req.body, {
      userId: req.user.id,
      username: req.user.username
    });
    notifySafe('exceptional_entry', {
      name: req.body?.name,
      idNumber: req.body?.idNumber,
      reason: req.body?.reason,
      entryId: result.entryId,
      userId: req.user.id,
      username: req.user.username || req.user.id
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Error en ingreso excepcional' });
  }
});

router.post('/api/access/kiosk-scan', auth, requirePermission('access.kiosk'), async (req, res) => {
  const t0 = Date.now();
  try {
    const normalized = normalizeAccessIngestRequest({
      rawData: req.body?.rawData,
      doorId: req.body?.doorId || null,
      readerId: req.body?.readerId || 'default'
    }, req.user.id);

    if (!normalized.ok) {
      return res.status(normalized.status).json({ message: normalized.message });
    }

    const result = await processKioskScan(normalized.args);

    console.log('[kiosk-scan-http]', JSON.stringify({
      wallMs: Date.now() - t0,
      authorized: result?.authorized,
      movementType: result?.movementType,
      relayMode: result?.relayMode,
      doorId: result?.door?.id || null
    }));
    res.json(result);
  } catch (err) {
    console.log('[kiosk-scan-http]', JSON.stringify({
      wallMs: Date.now() - t0,
      error: err.message
    }));
    sendServerError(res, err, 'Error en control de acceso');
  }
});

/**
 * Ingest unificado (Fase A): DNI, tarjeta, biométrico u otros hardwares.
 * Misma autorización/apertura que kiosk-scan; contrato estable para marcas.
 */
router.post('/api/access/ingest', auth, requirePermission('access.kiosk'), async (req, res) => {
  const t0 = Date.now();
  try {
    const normalized = normalizeAccessIngestRequest(req.body || {}, req.user.id);
    if (!normalized.ok) {
      return res.status(normalized.status).json({ message: normalized.message });
    }

    const result = await processKioskScan(normalized.args);
    console.log('[access-ingest-http]', JSON.stringify({
      wallMs: Date.now() - t0,
      authorized: result?.authorized,
      authMethod: result?.authMethod || normalized.args.ingestMeta?.authMethod || null,
      vendor: normalized.args.ingestMeta?.vendor || null,
      doorId: result?.door?.id || null
    }));
    res.json({
      ...result,
      ingest: {
        ok: true,
        vendor: normalized.args.ingestMeta?.vendor || null,
        deviceId: normalized.args.ingestMeta?.deviceId || null
      }
    });
  } catch (err) {
    console.log('[access-ingest-http]', JSON.stringify({
      wallMs: Date.now() - t0,
      error: err.message
    }));
    sendServerError(res, err, 'Error en ingest de acceso');
  }
});

router.get(
  '/api/admin/access-hardware-brands',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'lectores.manage']),
  async (_req, res) => {
    res.json({
      brands: ACCESS_HARDWARE_BRANDS,
      profiles: ACCESS_COMMERCIAL_PROFILES,
      actuators: ACTUATOR_TEMPLATES
    });
  }
);

router.post('/api/access/evaluate', auth, requirePermission('master.personal.read'), async (req, res) => {
  try {
    const { idNumber, movementType = 'ingreso', entrySource = 'scan', name = '' } = req.body;
    const access = await evaluatePersonalAccess({ idNumber, movementType, entrySource, name });
    res.json({
      access: {
        authorized: access.authorized,
        reason: access.reason,
        authorizationType: access.authorizationType,
        authorizationLabel: access.authorizationLabel,
        message: access.message,
        displayName: access.displayName,
        hasAuthorization: Boolean(access.authorization)
      }
    });
  } catch (err) {
    sendServerError(res, err, 'Error al evaluar acceso');
  }
});

router.post('/api/scan/resolve', auth, requirePermission('master.personal.read'), async (req, res) => {
  try {
    const { rawData } = req.body;
    if (!rawData?.trim()) {
      return res.status(400).json({ message: 'Datos de escaneo vacíos' });
    }

    const parsed = parseScanData(rawData);
    const idNumber = normalizeIdNumber(parsed.idNumber);
    let personal = null;
    let source = 'manual';

    if (idNumber) {
      const personalSnap = await db.collection('personalMaster')
        .where('idNumberNormalized', '==', idNumber)
        .limit(1)
        .get();
      if (!personalSnap.empty) {
        const doc = personalSnap.docs[0];
        personal = { id: doc.id, ...doc.data() };
        source = 'master';
      }
    }

    const resolvedName = parsed.name || buildResolvedName(parsed);
    const authorization = idNumber ? await resolveAuthorization(idNumber) : null;
    if (authorization) source = authorization.reason || authorization.type;

    const resolved = {
      idNumber,
      name: authorization?.name || personal?.name || resolvedName,
      company: authorization?.company || personal?.company || parsed.company || '',
      destination: authorization?.destination || personal?.destination || parsed.destination || '',
      source,
      scanFormat: parsed.format || 'unknown',
      hasCitacion: authorization?.type === 'citacion',
      hasAuthorization: Boolean(authorization),
      rawData: parsed.rawData || rawData.trim()
    };

    if (!resolved.name && !resolved.idNumber) {
      return res.status(404).json({ message: 'No se pudo interpretar el escaneo', rawData: rawData.trim() });
    }

    const access = await evaluatePersonalAccess({
      idNumber: resolved.idNumber,
      name: resolved.name,
      movementType: 'ingreso',
      entrySource: source === 'manual' ? 'manual' : 'scan'
    });

    res.json({
      resolved,
      personal,
      authorization,
      citacion: authorization?.type === 'citacion' ? authorization : null,
      access: {
        authorized: access.authorized,
        reason: access.reason,
        authorizationType: access.authorizationType,
        authorizationLabel: access.authorizationLabel,
        message: access.message
      }
    });
  } catch (err) {
    sendServerError(res, err, 'Error al resolver escaneo');
  }
});

/**
 * Allowlist offline por puerta: resultado ya calculado con decidirAcceso.
 * El bridge la cachea localmente cuando offlineCache está activo.
 *
 * Query opcional:
 *   clientVersion + clientDateBucket → si coinciden con la meta vigente,
 *   responde { unchanged: true } sin reconstruir (ahorra cientos de lecturas).
 *   force=1 → reconstruye siempre.
 */
router.get(
  '/api/access/door-allowlist/:doorId',
  auth,
  requirePermission('access.kiosk'),
  async (req, res) => {
    try {
      const allowlist = await resolveDoorAllowlist(req.params.doorId, {
        clientVersion: req.query.clientVersion,
        clientDateBucket: req.query.clientDateBucket,
        force: req.query.force
      });
      if (allowlist.unchanged) {
        return res.status(200).json(allowlist);
      }
      res.json(allowlist);
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al armar allowlist',
        code: err.code
      });
    }
  }
);

/**
 * Lote de eventos registrados en la mini PC sin internet.
 * Idempotente por offlineLocalId.
 */
router.post(
  '/api/access/offline-entries',
  auth,
  requirePermission('access.kiosk'),
  async (req, res) => {
    try {
      const events = req.body?.events || req.body?.entries || [];
      const result = await ingestOfflineEntries(events, {
        actorId: req.user?.id || req.user?.username || null,
        username: resolveAuthUsername(req.user)
      });
      res.json({
        ok: true,
        ...result
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al sincronizar entradas offline',
        code: err.code
      });
    }
  }
);

module.exports = router;
