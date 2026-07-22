const { db, FieldValue } = require('./firestore');
const { triggerRelay, resolveDriverId } = require('./lib/doorDrivers');
const { getAccessControlConfig } = require('./lib/accessControlStore');
const {
  getDoorsConfig,
  findDoorById,
  findDoorByReader,
  findAirlockGroup,
  getAirlockDoors
} = require('./lib/doorsConfig');

const AIRLOCK_COLLECTION = 'doorAirlockStates';
const MANUAL_COOLDOWN_MS = 3000;
const manualCooldownByDoor = new Map();
const airlockTimers = new Map();

const logDoorEvent = async (event) => {
  await db.collection('accessEvents').add({
    ...event,
    createdAt: FieldValue.serverTimestamp()
  });
};

const buildRelayConfigForDoor = (door, globalConfig = {}, overrides = {}) => {
  const driver = resolveDriverId(door.device?.driver);
  const doorSeconds = Number(door.pulseSeconds);
  const globalSeconds = Number(globalConfig.pulseSeconds);
  const overrideSeconds = Number(overrides.pulseSeconds);
  const pulseSeconds = Number.isFinite(overrideSeconds) && overrideSeconds > 0
    ? overrideSeconds
    : (Number.isFinite(doorSeconds) && doorSeconds > 0
      ? doorSeconds
      : (Number.isFinite(globalSeconds) && globalSeconds > 0 ? globalSeconds : 3));

  let pulseMode = overrides.pulseMode
    || door.pulseMode
    || globalConfig.pulseMode
    || 'timed';
  if (pulseMode === 'inherit') {
    pulseMode = globalConfig.pulseMode === 'jog' ? 'jog' : 'timed';
  }
  // Si hay temporizador configurado en la puerta, forzar timed.
  if (!overrides.pulseMode && Number.isFinite(doorSeconds) && doorSeconds > 0) {
    pulseMode = 'timed';
  }

  return {
    enabled: globalConfig.enabled !== false,
    driver,
    host: door.device?.host || globalConfig.host || '192.168.1.100',
    port: Number(door.device?.port || globalConfig.port || 6722),
    bridgeUrl: door.device?.bridgeUrl || globalConfig.bridgeUrl || '',
    bridgeSecret: door.device?.bridgeSecret || globalConfig.bridgeSecret || '',
    relayChannel: Number(door.device?.channel || globalConfig.relayChannel || 1),
    httpUrl: door.device?.httpUrl || '',
    httpMethod: door.device?.httpMethod || 'POST',
    httpAuthToken: door.device?.httpAuthToken || '',
    pulseMode,
    pulseSeconds: Math.max(1, Math.min(99, pulseSeconds))
  };
};

const isDoorRelayConfigured = (door, globalConfig = {}) => {
  const driver = resolveDriverId(door.device?.driver);
  if (driver === 'generic_http') {
    return Boolean(String(door.device?.httpUrl || '').trim());
  }
  const relay = buildRelayConfigForDoor(door, globalConfig);
  return Boolean(String(relay.bridgeUrl || '').trim()) || Boolean(String(relay.host || '').trim());
};

const getAirlockState = async (groupId) => {
  const snap = await db.collection(AIRLOCK_COLLECTION).doc(groupId).get();
  if (!snap.exists) {
    return {
      groupId,
      phase: 'idle',
      outerOpenedAt: null,
      outerClosedAt: null,
      innerOpenedAt: null,
      innerAllowedAt: null,
      lastPersonId: null,
      lastEntryId: null
    };
  }
  const data = snap.data();
  return {
    groupId,
    phase: data.phase || 'idle',
    outerOpenedAt: data.outerOpenedAt?.toDate ? data.outerOpenedAt.toDate().toISOString() : data.outerOpenedAt || null,
    outerClosedAt: data.outerClosedAt?.toDate ? data.outerClosedAt.toDate().toISOString() : data.outerClosedAt || null,
    innerOpenedAt: data.innerOpenedAt?.toDate ? data.innerOpenedAt.toDate().toISOString() : data.innerOpenedAt || null,
    innerAllowedAt: data.innerAllowedAt?.toDate ? data.innerAllowedAt.toDate().toISOString() : data.innerAllowedAt || null,
    lastPersonId: data.lastPersonId || null,
    lastEntryId: data.lastEntryId || null
  };
};

const setAirlockState = async (groupId, updates = {}) => {
  await db.collection(AIRLOCK_COLLECTION).doc(groupId).set({
    groupId,
    ...updates,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
};

const clearAirlockTimer = (groupId) => {
  const timers = airlockTimers.get(groupId);
  if (!timers) return;
  timers.forEach((timer) => clearTimeout(timer));
  airlockTimers.delete(groupId);
};

const scheduleAirlockTransition = (groupId, delayMs, handler) => {
  clearAirlockTimer(groupId);
  const timer = setTimeout(async () => {
    try {
      await handler();
    } catch (err) {
      console.error('[doorController] airlock timer error', groupId, err.message);
    }
  }, delayMs);
  airlockTimers.set(groupId, [timer]);
};

const resetAirlockState = async (groupId, reason = 'reset') => {
  clearAirlockTimer(groupId);
  await setAirlockState(groupId, {
    phase: 'idle',
    outerOpenedAt: null,
    outerClosedAt: null,
    innerOpenedAt: null,
    innerAllowedAt: null,
    resetReason: reason
  });
};

const evaluateAirlockForOpen = async ({ door, group, bypassAirlock = false, manual = false }) => {
  if (!group || bypassAirlock || manual) {
    return { allowed: true, phase: 'bypass' };
  }

  const state = await getAirlockState(group.id);
  const role = door.airlockRole;

  if (role === 'outer') {
    if (state.phase === 'idle') {
      return { allowed: true, phase: 'idle', nextPhase: 'outer_open' };
    }
    return {
      allowed: false,
      phase: state.phase,
      message: 'Estanco en uso. Espere a que se complete el tránsito.'
    };
  }

  if (role === 'inner') {
    if (state.phase === 'inner_allowed') {
      return { allowed: true, phase: state.phase, nextPhase: 'inner_open' };
    }
    if (state.phase === 'outer_open') {
      return {
        allowed: false,
        phase: state.phase,
        message: 'Espere a que la puerta exterior cierre por completo.'
      };
    }
    if (state.phase === 'outer_closed_pending') {
      return {
        allowed: false,
        phase: state.phase,
        message: 'Puerta exterior cerrando. Aguarde el retardo configurado.'
      };
    }
    return {
      allowed: false,
      phase: state.phase,
      message: 'Debe autorizarse primero en la puerta exterior del estanco.'
    };
  }

  return { allowed: true, phase: state.phase };
};

const afterOuterDoorOpened = async ({ group, personId = null, entryId = null }) => {
  const now = FieldValue.serverTimestamp();
  await setAirlockState(group.id, {
    phase: 'outer_open',
    outerOpenedAt: now,
    outerClosedAt: null,
    innerOpenedAt: null,
    innerAllowedAt: null,
    lastPersonId: personId,
    lastEntryId: entryId
  });

  scheduleAirlockTransition(group.id, group.outerCloseDelayMs, async () => {
    await setAirlockState(group.id, {
      phase: 'outer_closed_pending',
      outerClosedAt: FieldValue.serverTimestamp()
    });

    scheduleAirlockTransition(group.id, group.interDoorDelayMs, async () => {
      await setAirlockState(group.id, {
        phase: 'inner_allowed',
        innerAllowedAt: FieldValue.serverTimestamp()
      });

      scheduleAirlockTransition(group.id, group.transitTimeoutMs, async () => {
        await resetAirlockState(group.id, 'transit_timeout');
      });
    });
  });
};

const afterInnerDoorOpened = async ({ group }) => {
  await setAirlockState(group.id, {
    phase: 'inner_open',
    innerOpenedAt: FieldValue.serverTimestamp()
  });

  scheduleAirlockTransition(group.id, 3000, async () => {
    await resetAirlockState(group.id, 'transit_complete');
  });
};

const pulseDoorRelay = async (door, globalConfig, { force = false, pulseSeconds, pulseMode } = {}) => {
  const relayConfig = buildRelayConfigForDoor(door, globalConfig, { pulseSeconds, pulseMode });
  if (!isDoorRelayConfigured(door, globalConfig)) {
    const error = new Error(`Puerta "${door.name}" sin dispositivo configurado`);
    error.status = 503;
    throw error;
  }
  return triggerRelay(relayConfig, { force: force || !globalConfig.enabled });
};

const openDoor = async ({
  doorId,
  readerId = null,
  username = null,
  userId = null,
  reason = '',
  bypassAirlock = false,
  manual = false,
  force = false,
  personId = null,
  entryId = null,
  authMethod = null,
  movementType = 'ingreso',
  pulseSeconds = null,
  pulseMode = null
}) => {
  const [globalConfig, doorsConfig] = await Promise.all([
    getAccessControlConfig(),
    getDoorsConfig()
  ]);

  const door = (() => {
    if (doorId) {
      const exact = findDoorById(doorsConfig, doorId);
      if (exact) return exact;
    } else if (readerId) {
      const byReader = findDoorByReader(doorsConfig, readerId);
      if (byReader) return byReader;
    }
    // Fallback solo si no mandaron doorId explícito (apertura genérica).
    if (!doorId) {
      return findDoorById(doorsConfig, doorsConfig.defaultDoorId)
        || (doorsConfig.doors || []).find((d) => d.active !== false)
        || null;
    }
    return null;
  })();

  if (!door) {
    const available = (doorsConfig.doors || [])
      .filter((d) => d.active !== false)
      .map((d) => `${d.id} (${d.name || 'sin nombre'})`);
    const error = new Error(
      doorId
        ? `Puerta "${doorId}" no encontrada o inactiva. Activas: ${available.join(', ') || 'ninguna — guardá al menos una en Admin → Puertas'}.`
        : `No hay puertas activas configuradas. Guardá al menos una en Admin → Puertas y acceso.`
    );
    error.status = 404;
    throw error;
  }

  if (manual && door.manualOpenAllowed === false) {
    const error = new Error(`Apertura manual deshabilitada en ${door.name}`);
    error.status = 403;
    throw error;
  }

  const cooldownKey = door.id;
  const now = Date.now();
  const lastOpen = manualCooldownByDoor.get(cooldownKey) || 0;
  if (now - lastOpen < MANUAL_COOLDOWN_MS) {
    const error = new Error('Espere unos segundos antes de volver a abrir esta puerta');
    error.status = 429;
    throw error;
  }

  const group = door.airlockGroupId
    ? findAirlockGroup(doorsConfig, door.airlockGroupId)
    : null;

  const airlockCheck = await evaluateAirlockForOpen({ door, group, bypassAirlock, manual });
  if (!airlockCheck.allowed) {
    const error = new Error(airlockCheck.message || 'Puerta bloqueada por secuencia de estanco');
    error.status = 423;
    error.airlock = airlockCheck;
    throw error;
  }

  try {
    const relay = await pulseDoorRelay(door, globalConfig, {
      force: manual || force || bypassAirlock,
      pulseSeconds,
      pulseMode
    });
    manualCooldownByDoor.set(cooldownKey, now);

    if (group && door.airlockRole === 'outer' && !bypassAirlock && !manual) {
      await afterOuterDoorOpened({ group, personId, entryId });
    } else if (group && door.airlockRole === 'inner' && !bypassAirlock && !manual) {
      await afterInnerDoorOpened({ group });
    }

    await logDoorEvent({
      type: manual ? 'manual_open' : 'door_open',
      movementType,
      entrySource: manual ? 'guard_manual' : 'automated',
      doorId: door.id,
      doorName: door.name,
      airlockGroupId: group?.id || null,
      airlockRole: door.airlockRole || null,
      authMethod: authMethod || (manual ? 'manual' : null),
      username,
      userId,
      personId,
      entryId,
      reason: reason || (manual ? 'apertura_manual_guardia' : 'acceso_autorizado'),
      relayTriggered: true,
      relayCommand: relay.command,
      relayVia: relay.via,
      relayChannel: buildRelayConfigForDoor(door, globalConfig).relayChannel
    });

    const airlockState = group ? await getAirlockState(group.id) : null;

    return {
      message: manual ? `${door.name} abierta manualmente` : `${door.name} abierta`,
      door: { id: door.id, name: door.name, airlockRole: door.airlockRole },
      relay,
      airlock: group ? {
        groupId: group.id,
        groupName: group.name,
        state: airlockState
      } : null
    };
  } catch (err) {
    await logDoorEvent({
      type: manual ? 'manual_open' : 'door_open',
      movementType,
      entrySource: manual ? 'guard_manual' : 'automated',
      doorId: door.id,
      doorName: door.name,
      airlockGroupId: group?.id || null,
      username,
      userId,
      reason: reason || 'error_apertura',
      relayTriggered: false,
      relayError: err.message
    });
    try {
      const { notifySafe } = require('./lib/notifications');
      notifySafe('door_relay_failure', {
        doorId: door.id,
        doorName: door.name,
        error: err.message,
        username,
        driver: door.device?.driver || 'sr201'
      });
    } catch (notifyErr) {
      console.error('[doorController] notify hook', notifyErr.message);
    }
    throw err;
  }
};

const resolveDoorContext = async ({ doorId, readerId }) => {
  const doorsConfig = await getDoorsConfig();
  const door = doorId
    ? findDoorById(doorsConfig, doorId)
    : findDoorByReader(doorsConfig, readerId);

  if (!door) {
    const error = new Error('Puerta no configurada para este lector');
    error.status = 404;
    throw error;
  }

  const group = door.airlockGroupId
    ? findAirlockGroup(doorsConfig, door.airlockGroupId)
    : null;

  const airlockState = group ? await getAirlockState(group.id) : null;
  const airlockDoors = group ? getAirlockDoors(doorsConfig, group.id) : [];

  return { door, group, airlockState, airlockDoors, doorsConfig };
};

const listActiveDoors = async () => {
  const doorsConfig = await getDoorsConfig();
  return {
    defaultDoorId: doorsConfig.defaultDoorId,
    doors: (doorsConfig.doors || []).filter((door) => door.active !== false),
    airlockGroups: (doorsConfig.airlockGroups || []).filter((group) => group.enabled !== false)
  };
};

/**
 * Estado físico (relé) por puerta vía bridge.
 * Abierta = canal activado (1); Cerrada = canal en reposo (0).
 */
const getDoorsPhysicalStatus = async () => {
  const { queryRelayStatusViaBridge } = require('./lib/doorDrivers/sr201');
  const [globalConfig, doorsConfig] = await Promise.all([
    getAccessControlConfig(),
    getDoorsConfig()
  ]);

  const bridgeUrl = String(globalConfig.bridgeUrl || '').trim();
  if (!bridgeUrl) {
    return {
      ok: false,
      message: 'Sin URL de puente: no se puede leer el estado físico',
      doors: []
    };
  }

  const doors = (doorsConfig.doors || []).filter((d) => d.active !== false);
  const byHost = new Map();

  for (const door of doors) {
    const relay = buildRelayConfigForDoor(door, globalConfig);
    const host = relay.host;
    const port = relay.port;
    const key = `${host}:${port}`;
    if (!byHost.has(key)) {
      byHost.set(key, { host, port, bridgeSecret: relay.bridgeSecret, doorIds: [] });
    }
    byHost.get(key).doorIds.push({
      doorId: door.id,
      doorName: door.name,
      channel: relay.relayChannel
    });
  }

  const doorsStatus = [];
  const boardErrors = [];

  for (const board of byHost.values()) {
    try {
      const status = await queryRelayStatusViaBridge(bridgeUrl, {
        host: board.host,
        port: board.port,
        bridgeSecret: board.bridgeSecret || globalConfig.bridgeSecret || ''
      });
      const channels = status.channels || {};
      for (const item of board.doorIds) {
        const relayOn = channels[item.channel] === true;
        const known = Object.prototype.hasOwnProperty.call(channels, item.channel);
        doorsStatus.push({
          doorId: item.doorId,
          doorName: item.doorName,
          host: board.host,
          channel: item.channel,
          relayOn: known ? relayOn : null,
          physicalState: !known ? 'unknown' : (relayOn ? 'open' : 'closed'),
          physicalLabel: !known ? 'Sin dato' : (relayOn ? 'Abierta' : 'Cerrada'),
          raw: status.raw || null,
          queriedAt: status.queriedAt || new Date().toISOString()
        });
      }
    } catch (err) {
      boardErrors.push({ host: board.host, message: err.message });
      for (const item of board.doorIds) {
        doorsStatus.push({
          doorId: item.doorId,
          doorName: item.doorName,
          host: board.host,
          channel: item.channel,
          relayOn: null,
          physicalState: 'error',
          physicalLabel: 'Sin lectura',
          error: err.message,
          queriedAt: new Date().toISOString()
        });
      }
    }
  }

  return {
    ok: boardErrors.length === 0,
    message: boardErrors.length
      ? `Algunas placas no respondieron (${boardErrors.length})`
      : 'Estado físico actualizado',
    doors: doorsStatus,
    boardErrors
  };
};

module.exports = {
  buildRelayConfigForDoor,
  isDoorRelayConfigured,
  getAirlockState,
  resetAirlockState,
  openDoor,
  resolveDoorContext,
  listActiveDoors,
  getDoorsPhysicalStatus,
  evaluateAirlockForOpen
};
