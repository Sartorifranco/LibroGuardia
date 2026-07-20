const express = require('express');
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
  resetAirlockState
} = require('../doorController');
const {
  evaluatePersonalAccess,
  manualOpenDoor,
  processKioskScan,
  validarAcceso
} = require('../accessControl');
const {
  checkAccessStatus,
  preRegisterVisitor,
  registerExceptionalEntry
} = require('../guard');
const { logAdminAction } = require('../lib/auditLog');
const { notifySafe } = require('../lib/notifications');
const {
  auth,
  requirePermission,
  requireAnyPermission
} = require('../middleware/auth');

const router = express.Router();

const buildResolvedName = (parsed) => {
  if (parsed.name) return parsed.name;
  return [parsed.firstName, parsed.lastName].filter(Boolean).join(' ').trim();
};

router.get('/api/admin/access-control', auth, requirePermission('access.control'), async (_req, res) => {
  try {
    const config = await getAccessControlConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener configuración de acceso', error: err.message });
  }
});

router.put('/api/admin/access-control', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const allowedKeys = Object.keys(DEFAULT_ACCESS_CONTROL);
    const updates = {};
    allowedKeys.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    await db.collection('settings').doc('accessControl').set(updates, { merge: true });
    const config = await getAccessControlConfig();
    res.json({ message: 'Configuración de acceso actualizada', config });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar configuración de acceso', error: err.message });
  }
});

router.post('/api/access/test-relay', auth, requireAnyPermission(['access.control', 'access.doors.manage']), async (req, res) => {
  try {
    const doorsConfig = await getDoorsConfig();
    const doorId = req.body?.doorId || doorsConfig.defaultDoorId || doorsConfig.doors?.[0]?.id;
    if (!doorId) {
      return res.status(400).json({ message: 'No hay puertas configuradas para probar' });
    }
    const result = await openDoor({
      doorId,
      username: req.user?.username,
      manual: true,
      bypassAirlock: true,
      force: true,
      reason: 'test_relay'
    });
    res.json({ message: 'Pulso de prueba enviado', ...result });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al probar relevador SR201',
      error: err.message
    });
  }
});

router.post('/api/guard/open-door', auth, requirePermission('access.manual_open'), async (req, res) => {
  try {
    const result = await manualOpenDoor({
      username: req.user?.username || req.user?.id,
      userId: req.user?.id || null,
      reason: req.body?.reason || 'apertura_manual_guardia',
      doorId: req.body?.doorId || null,
      bypassAirlock: req.body?.bypassAirlock === true
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al abrir la puerta',
      error: err.message,
      airlock: err.airlock || undefined
    });
  }
});

router.get('/api/guard/doors', auth, requirePermission('access.manual_open'), async (_req, res) => {
  try {
    res.json(await listActiveDoors());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/api/admin/doors-config', auth, requireAnyPermission(['access.doors.manage', 'access.control']), async (_req, res) => {
  try {
    const [config, globalAccess, meta] = await Promise.all([
      getDoorsConfig(),
      getAccessControlConfig(),
      getDoorsConfigMeta()
    ]);
    res.json({
      config,
      globalAccess,
      authMethods: AUTH_METHODS,
      meta: {
        ...meta,
        legacyFallback: !meta.hasStoredDoors
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/api/admin/doors-config', auth, requireAnyPermission(['access.doors.manage', 'access.control']), async (req, res) => {
  try {
    const before = await getDoorsConfig();
    const { globalAccess, ...doorsPayload } = req.body || {};
    const config = await saveDoorsConfig(doorsPayload);
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
        doors: before.doors,
        airlockGroups: before.airlockGroups,
        defaultDoorId: before.defaultDoorId
      },
      after: {
        doors: config.doors,
        airlockGroups: config.airlockGroups,
        defaultDoorId: config.defaultDoorId,
        globalAccessUpdated: Boolean(savedGlobalAccess)
      }
    }).catch((err) => console.error('auditLog door.config.update:', err.message));
    res.json({
      message: 'Configuración de puertas y acceso guardada',
      config,
      globalAccess: savedGlobalAccess || await getAccessControlConfig()
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/api/guard/airlock/:groupId', auth, requirePermission('access.manual_open'), async (req, res) => {
  try {
    res.json({ state: await getAirlockState(req.params.groupId) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/api/guard/airlock/:groupId/reset', auth, requirePermission('access.doors.manage'), async (req, res) => {
  try {
    await resetAirlockState(req.params.groupId, req.body?.reason || 'manual_reset');
    res.json({ message: 'Estanco reiniciado', state: await getAirlockState(req.params.groupId) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/api/access/validar', auth, async (req, res) => {
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
    res.status(500).json({ message: 'Error al validar acceso', error: err.message });
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
    res.status(500).json({ message: 'Error al consultar acceso', error: err.message });
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

router.post('/api/access/kiosk-scan', auth, async (req, res) => {
  try {
    const { rawData } = req.body;
    if (!rawData?.trim()) {
      return res.status(400).json({ message: 'Datos de escaneo vacíos' });
    }

    const result = await processKioskScan({
      rawData,
      username: req.user.id,
      doorId: req.body?.doorId || null,
      readerId: req.body?.readerId || 'default'
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error en control de acceso', error: err.message });
  }
});

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
    res.status(500).json({ message: 'Error al evaluar acceso', error: err.message });
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
    res.status(500).json({ message: 'Error al resolver escaneo', error: err.message });
  }
});

module.exports = router;
