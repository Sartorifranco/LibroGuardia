const { db, FieldValue } = require('./firestore');
const { triggerRelay } = require('./sr201');
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

const buildRelayConfigForDoor = (door, globalConfig = {}) => ({
  enabled: globalConfig.enabled !== false,
  host: door.device?.host || globalConfig.host || '192.168.1.100',
  port: Number(door.device?.port || globalConfig.port || 6722),
  bridgeUrl: door.device?.bridgeUrl || globalConfig.bridgeUrl || '',
  bridgeSecret: door.device?.bridgeSecret || globalConfig.bridgeSecret || '',
  relayChannel: Number(door.device?.channel || globalConfig.relayChannel || 1),
  pulseMode: door.pulseMode === 'inherit' ? (globalConfig.pulseMode || 'jog') : door.pulseMode,
  pulseSeconds: Number(door.pulseSeconds || globalConfig.pulseSeconds || 3)
});

const isDoorRelayConfigured = (door, globalConfig = {}) => {
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

const pulseDoorRelay = async (door, globalConfig, { force = false } = {}) => {
  const relayConfig = buildRelayConfigForDoor(door, globalConfig);
  if (!isDoorRelayConfigured(door, globalConfig)) {
    const error = new Error(`Puerta "${door.name}" sin dispositivo SR201 configurado`);
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
  movementType = 'ingreso'
}) => {
  const [globalConfig, doorsConfig] = await Promise.all([
    getAccessControlConfig(),
    getDoorsConfig()
  ]);

  const door = doorId
    ? findDoorById(doorsConfig, doorId)
    : findDoorByReader(doorsConfig, readerId);

  if (!door) {
    const error = new Error('Puerta no encontrada o inactiva');
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
    const relay = await pulseDoorRelay(door, globalConfig, { force: manual || force || bypassAirlock });
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

module.exports = {
  buildRelayConfigForDoor,
  isDoorRelayConfigured,
  getAirlockState,
  resetAirlockState,
  openDoor,
  resolveDoorContext,
  listActiveDoors,
  evaluateAirlockForOpen
};
