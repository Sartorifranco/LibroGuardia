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
/** Último pulso por puerta (antes un Map en memoria: cada instancia tenía el suyo). */
const COOLDOWN_COLLECTION = 'doorOpenCooldowns';
const MANUAL_COOLDOWN_MS = 3000;
/** Tras abrir la interior, el estanco vuelve a idle a los 3 s (igual que el timer anterior). */
const INNER_OPEN_RESET_MS = 3000;
const AIRLOCK_DEFAULTS = {
  outerCloseDelayMs: 5000,
  interDoorDelayMs: 2000,
  transitTimeoutMs: 120000
};

const logDoorEvent = async (event) => {
  await db.collection('accessEvents').add({
    ...event,
    createdAt: FieldValue.serverTimestamp()
  });
};

/**
 * Estado de confirmación del pulso para auditoría.
 * - 'confirmado': la placa (o el puente) respondió.
 * - 'sin_confirmacion': el comando se envió pero la placa no contestó: NO es un éxito pleno.
 * - 'en_cola': modo local, lo dispara la estación.
 * - 'desconocido': driver/puente viejo que no informa confirmación.
 */
const describeRelayConfirmation = (relay = {}) => {
  if (relay.via === 'local-queue') return { relayConfirmed: null, relayStatus: 'en_cola' };
  if (relay.confirmed === false) return { relayConfirmed: false, relayStatus: 'sin_confirmacion' };
  if (relay.confirmed === true) return { relayConfirmed: true, relayStatus: 'confirmado' };
  return { relayConfirmed: null, relayStatus: 'desconocido' };
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

const toMillis = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};

const toIso = (value) => {
  const ms = toMillis(value);
  return ms == null ? null : new Date(ms).toISOString();
};

const airlockTimings = (group = {}) => ({
  outerCloseDelayMs: Number(group?.outerCloseDelayMs) > 0
    ? Number(group.outerCloseDelayMs) : AIRLOCK_DEFAULTS.outerCloseDelayMs,
  interDoorDelayMs: Number.isFinite(Number(group?.interDoorDelayMs)) && Number(group.interDoorDelayMs) >= 0
    ? Number(group.interDoorDelayMs) : AIRLOCK_DEFAULTS.interDoorDelayMs,
  transitTimeoutMs: Number(group?.transitTimeoutMs) > 0
    ? Number(group.transitTimeoutMs) : AIRLOCK_DEFAULTS.transitTimeoutMs
});

/**
 * Fase EFECTIVA del estanco derivada del tiempo transcurrido.
 *
 * Antes las transiciones (outer_open → outer_closed_pending → inner_allowed →
 * idle) las hacían setTimeout en memoria de la instancia que abrió: con varias
 * instancias de Cloud Functions (o la instancia congelada tras responder) el
 * estado quedaba trabado u otra instancia no lo veía. Ahora el doc solo guarda
 * el instante de apertura y cualquier instancia calcula la fase igual.
 */
const deriveAirlockPhase = (data = {}, group = {}, nowMs = Date.now()) => {
  const stored = data?.phase || 'idle';
  if (stored === 'idle') return 'idle';
  const t = airlockTimings(group);

  if (stored === 'inner_open') {
    const t1 = data.innerOpenedAtMs ?? toMillis(data.innerOpenedAt) ?? toMillis(data.updatedAt);
    if (t1 == null) return 'idle';
    return nowMs - t1 < INNER_OPEN_RESET_MS ? 'inner_open' : 'idle';
  }

  // outer_open / outer_closed_pending / inner_allowed: anclados a la apertura exterior.
  const t0 = data.outerOpenedAtMs ?? toMillis(data.outerOpenedAt) ?? toMillis(data.updatedAt);
  if (t0 == null) return 'idle';
  const elapsed = nowMs - t0;
  if (elapsed < t.outerCloseDelayMs) return 'outer_open';
  if (elapsed < t.outerCloseDelayMs + t.interDoorDelayMs) return 'outer_closed_pending';
  if (elapsed < t.outerCloseDelayMs + t.interDoorDelayMs + t.transitTimeoutMs) return 'inner_allowed';
  return 'idle';
};

const resolveGroupForState = async (groupId, group) => {
  if (group) return group;
  try {
    return findAirlockGroup(await getDoorsConfig(), groupId) || null;
  } catch (_err) {
    return null;
  }
};

const getAirlockState = async (groupId, group = null, nowMs = Date.now()) => {
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
  const data = snap.data() || {};
  const effectiveGroup = await resolveGroupForState(groupId, group);
  return {
    groupId,
    phase: deriveAirlockPhase(data, effectiveGroup || {}, nowMs),
    outerOpenedAt: toIso(data.outerOpenedAtMs ?? data.outerOpenedAt),
    outerClosedAt: toIso(data.outerClosedAt),
    innerOpenedAt: toIso(data.innerOpenedAtMs ?? data.innerOpenedAt),
    innerAllowedAt: toIso(data.innerAllowedAt),
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

const IDLE_AIRLOCK_FIELDS = {
  phase: 'idle',
  outerOpenedAt: null,
  outerOpenedAtMs: null,
  outerClosedAt: null,
  innerOpenedAt: null,
  innerOpenedAtMs: null,
  innerAllowedAt: null
};

const resetAirlockState = async (groupId, reason = 'reset') => {
  await setAirlockState(groupId, {
    ...IDLE_AIRLOCK_FIELDS,
    resetReason: reason
  });
};

/** Regla del estanco para una fase ya derivada. Pura. */
const evaluateAirlockPhase = (role, phase) => {
  const state = { phase };
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

/**
 * Regla del estanco para aperturas MANUALES. Pura.
 * No exige la secuencia exterior → interior (el guardia puede abrir para salir),
 * pero nunca deja abrir una puerta mientras la otra del mismo estanco está abierta
 * (o cerrándose). code AIRLOCK_OTHER_OPEN → HTTP 409, forzable con permiso.
 */
const evaluateManualAirlockPhase = (role, phase, otherDoorName = '') => {
  const otherOpen = (role === 'outer' && phase === 'inner_open')
    || (role === 'inner' && (phase === 'outer_open' || phase === 'outer_closed_pending'));
  if (otherOpen) {
    const label = String(otherDoorName || '').trim()
      || (role === 'outer' ? 'interior' : 'exterior');
    return {
      allowed: false,
      phase,
      code: 'AIRLOCK_OTHER_OPEN',
      otherDoorName: label,
      message: `No se puede abrir: la otra puerta del estanco (${label}) está abierta. Esperá a que se cierre.`
    };
  }
  return { allowed: true, phase, nextPhase: role === 'outer' ? 'outer_open' : 'inner_open' };
};

const evaluateAirlockForOpen = async ({
  door,
  group,
  bypassAirlock = false,
  manual = false,
  otherDoorName = '',
  nowMs = Date.now()
}) => {
  if (!group || bypassAirlock) {
    return { allowed: true, phase: 'bypass' };
  }
  const state = await getAirlockState(group.id, group, nowMs);
  return manual
    ? evaluateManualAirlockPhase(door.airlockRole, state.phase, otherDoorName)
    : evaluateAirlockPhase(door.airlockRole, state.phase);
};

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

/**
 * Reserva atómica (transacción Firestore) antes de pulsar:
 * - cooldown por puerta (MANUAL_COOLDOWN_MS) compartido entre instancias;
 * - chequeo + transición del estanco (outer → outer_open, inner → inner_open),
 *   así dos lecturas simultáneas en instancias distintas no abren ambas.
 * Devuelve lo necesario para revertir si el pulso falla.
 */
const reserveDoorOpen = async ({
  door,
  group,
  airlockApplies,
  personId = null,
  entryId = null,
  manual = false,
  forceAirlock = false,
  otherDoorName = '',
  nowMs = Date.now()
}) => db.runTransaction(async (tx) => {
  const cooldownRef = db.collection(COOLDOWN_COLLECTION).doc(door.id);
  const airlockRef = airlockApplies ? db.collection(AIRLOCK_COLLECTION).doc(group.id) : null;
  const [cooldownSnap, airlockSnap] = await Promise.all([
    tx.get(cooldownRef),
    airlockRef ? tx.get(airlockRef) : Promise.resolve(null)
  ]);

  const previousCooldownMs = cooldownSnap?.exists ? Number(cooldownSnap.data()?.lastOpenAtMs) || 0 : 0;
  if (nowMs - previousCooldownMs < MANUAL_COOLDOWN_MS && nowMs >= previousCooldownMs) {
    throw httpError(429, 'Espere unos segundos antes de volver a abrir esta puerta');
  }

  let airlockCheck = { allowed: true, phase: 'bypass' };
  let previousAirlock = null;
  let forcedAirlock = null;
  if (airlockRef) {
    const data = airlockSnap?.exists ? (airlockSnap.data() || {}) : {};
    previousAirlock = data;
    const phase = deriveAirlockPhase(data, group, nowMs);
    airlockCheck = manual
      ? evaluateManualAirlockPhase(door.airlockRole, phase, otherDoorName)
      : evaluateAirlockPhase(door.airlockRole, phase);
    if (!airlockCheck.allowed) {
      if (manual && forceAirlock) {
        // Apertura forzada (permiso puertas.estanco.forzar + motivo, validado por la ruta).
        // Se registra el estado que se pisó; la auditoría la hace openDoor / la ruta.
        forcedAirlock = { ...airlockCheck };
        airlockCheck = { allowed: true, phase, forced: true };
      } else if (manual) {
        throw httpError(409, airlockCheck.message, {
          code: 'AIRLOCK_OTHER_OPEN',
          airlock: { ...airlockCheck, forcible: true }
        });
      } else {
        throw httpError(423, airlockCheck.message || 'Puerta bloqueada por secuencia de estanco', {
          airlock: airlockCheck
        });
      }
    }
    if (door.airlockRole === 'outer') {
      tx.set(airlockRef, {
        groupId: group.id,
        ...IDLE_AIRLOCK_FIELDS,
        phase: 'outer_open',
        outerOpenedAt: FieldValue.serverTimestamp(),
        outerOpenedAtMs: nowMs,
        lastPersonId: personId,
        lastEntryId: entryId,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else if (door.airlockRole === 'inner') {
      tx.set(airlockRef, {
        groupId: group.id,
        phase: 'inner_open',
        innerOpenedAt: FieldValue.serverTimestamp(),
        innerOpenedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }

  tx.set(cooldownRef, {
    doorId: door.id,
    lastOpenAtMs: nowMs,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return { airlockCheck, previousCooldownMs, previousAirlock, forcedAirlock };
});

/** El pulso falló: devolver cooldown y estanco a como estaban (best effort). */
const releaseDoorOpenReservation = async ({ door, group, airlockApplies, reservation }) => {
  try {
    await db.collection(COOLDOWN_COLLECTION).doc(door.id).set({
      doorId: door.id,
      lastOpenAtMs: reservation?.previousCooldownMs || 0,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (airlockApplies) {
      const prev = reservation?.previousAirlock || {};
      await setAirlockState(group.id, {
        ...IDLE_AIRLOCK_FIELDS,
        ...prev,
        resetReason: 'pulso_fallido'
      });
    }
  } catch (err) {
    console.error('[doorController] No se pudo revertir la reserva de apertura', door.id, err.message);
  }
};

const pulseDoorRelay = async (door, globalConfig, {
  force = false,
  pulseSeconds,
  pulseMode,
  requestedBy = null,
  reason = 'pulse_local'
} = {}) => {
  const relayConfig = buildRelayConfigForDoor(door, globalConfig, { pulseSeconds, pulseMode });
  if (!isDoorRelayConfigured(door, globalConfig)) {
    const error = new Error(`Puerta "${door.name}" sin dispositivo configurado`);
    error.status = 503;
    throw error;
  }

  // Modo local: no usar túnel. Encolar para que el bridge de planta dispare por LAN.
  const { resolveRelayMode, buildLocalRelayPayload } = require('./lib/relayDispatch');
  if (resolveRelayMode(door) === 'local') {
    const { enqueuePendingLocalOpen } = require('./lib/pendingLocalOpens');
    const localRelay = buildLocalRelayPayload(relayConfig);
    const queued = await enqueuePendingLocalOpen({
      doorId: door.id,
      localRelay,
      requestedBy,
      reason
    });
    return {
      via: 'local-queue',
      command: 'queued',
      host: localRelay.host,
      port: localRelay.port,
      channel: localRelay.channel,
      seconds: localRelay.pulseSeconds,
      mode: localRelay.pulseMode,
      queueId: queued.id,
      message: queued.message
    };
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
  /** Solo manual: abrir aunque la otra puerta del estanco esté abierta (queda auditado). */
  forceAirlock = false,
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

  const group = door.airlockGroupId
    ? findAirlockGroup(doorsConfig, door.airlockGroupId)
    : null;
  // Las aperturas manuales también respetan el estanco (nunca ambas puertas abiertas);
  // solo se puede forzar con forceAirlock (permiso + motivo validados por la ruta).
  const airlockApplies = Boolean(group)
    && !bypassAirlock
    && (door.airlockRole === 'outer' || door.airlockRole === 'inner');
  const otherDoor = airlockApplies
    ? getAirlockDoors(doorsConfig, group.id).find((d) => d.id !== door.id && d.airlockRole !== door.airlockRole)
    : null;

  // Cooldown + estanco en una transacción (429 / 423 automático / 409 manual).
  const reservation = await reserveDoorOpen({
    door,
    group,
    airlockApplies,
    personId,
    entryId,
    manual,
    forceAirlock: manual && forceAirlock === true,
    otherDoorName: otherDoor?.name || ''
  });
  const forcedAirlock = reservation?.forcedAirlock || null;

  let pulseSucceeded = false;
  try {
    const relay = await pulseDoorRelay(door, globalConfig, {
      force: manual || force || bypassAirlock,
      pulseSeconds,
      pulseMode,
      requestedBy: username || userId || null,
      reason: reason || (manual ? 'apertura_manual' : 'acceso_autorizado')
    });
    pulseSucceeded = true;

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
      relayChannel: buildRelayConfigForDoor(door, globalConfig).relayChannel,
      ...(forcedAirlock ? {
        forcedAirlock: true,
        forcedAirlockPhase: forcedAirlock.phase || null,
        forcedAirlockOtherDoor: forcedAirlock.otherDoorName || null
      } : {}),
      ...describeRelayConfirmation(relay)
    });

    const airlockState = group ? await getAirlockState(group.id, group) : null;

    return {
      message: relay.via === 'local-queue'
        ? (relay.message || `${door.name}: pedido enviado a la estación`)
        : (manual ? `${door.name} abierta manualmente` : `${door.name} abierta`),
      door: { id: door.id, name: door.name, airlockRole: door.airlockRole },
      relay,
      via: relay.via || null,
      forcedAirlock: forcedAirlock ? { phase: forcedAirlock.phase, otherDoorName: forcedAirlock.otherDoorName } : null,
      airlock: group ? {
        groupId: group.id,
        groupName: group.name,
        state: airlockState
      } : null
    };
  } catch (err) {
    if (!pulseSucceeded) {
      // La puerta no se abrió: liberar cooldown y estanco para no bloquear el reintento.
      await releaseDoorOpenReservation({ door, group, airlockApplies, reservation });
    }
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
      relayTriggered: pulseSucceeded,
      relayError: err.message
    }).catch((logErr) => {
      console.error('[doorController] No se pudo registrar el error de apertura', logErr.message);
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

  const airlockState = group ? await getAirlockState(group.id, group) : null;
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
 * Estado físico (relé) por puerta.
 * - Modo local: no consulta el túnel (la mini PC abre en planta).
 * - Modo nube: consulta vía conexión a planta.
 */
const getDoorsPhysicalStatus = async () => {
  const { queryRelayStatusViaBridge } = require('./lib/doorDrivers/sr201');
  const { resolveRelayMode } = require('./lib/relayDispatch');
  const [globalConfig, doorsConfig] = await Promise.all([
    getAccessControlConfig(),
    getDoorsConfig()
  ]);

  const bridgeUrl = String(globalConfig.bridgeUrl || '').trim();
  const activeDoors = (doorsConfig.doors || []).filter((d) => d.active !== false);
  const doorsStatus = [];
  const boardErrors = [];

  const localDoors = [];
  const cloudDoors = [];
  for (const door of activeDoors) {
    if (resolveRelayMode(door) === 'local') localDoors.push(door);
    else cloudDoors.push(door);
  }

  for (const door of localDoors) {
    const relay = buildRelayConfigForDoor(door, globalConfig);
    doorsStatus.push({
      doorId: door.id,
      doorName: door.name,
      host: relay.host,
      channel: relay.relayChannel,
      relayMode: 'local',
      relayOn: null,
      physicalState: 'local',
      physicalLabel: 'En planta',
      hint: 'Abre desde su estación local. El estado en vivo se controla en planta.',
      queriedAt: new Date().toISOString()
    });
  }

  if (cloudDoors.length === 0) {
    return {
      ok: true,
      message: localDoors.length
        ? 'Puertas en modo local: el estado se controla en planta'
        : 'Sin puertas activas',
      doors: doorsStatus,
      boardErrors: []
    };
  }

  if (!bridgeUrl) {
    for (const door of cloudDoors) {
      const relay = buildRelayConfigForDoor(door, globalConfig);
      doorsStatus.push({
        doorId: door.id,
        doorName: door.name,
        host: relay.host,
        channel: relay.relayChannel,
        relayMode: 'cloud',
        relayOn: null,
        physicalState: 'unknown',
        physicalLabel: 'Sin enlace',
        error: 'Falta la conexión a planta para leer el estado a distancia.',
        queriedAt: new Date().toISOString()
      });
    }
    return {
      ok: false,
      message: 'Hay puertas que abren a distancia y falta la conexión a planta',
      doors: doorsStatus,
      boardErrors: [{ host: '*', message: 'Sin conexión a planta' }]
    };
  }

  const byHost = new Map();
  for (const door of cloudDoors) {
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

  const friendlyBridgeError = (err) => {
    const raw = String(err?.message || err || '');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(raw)) {
      return 'No se pudo contactar la planta. Revisá la conexión a planta o pasá la puerta a modo local.';
    }
    if (/Falta la URL/i.test(raw)) {
      return 'Falta la conexión a planta.';
    }
    return raw.replace(/^No se pudo consultar estado vía puente:\s*/i, '') || 'No se pudo leer el estado';
  };

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
          relayMode: 'cloud',
          relayOn: known ? relayOn : null,
          physicalState: !known ? 'unknown' : (relayOn ? 'open' : 'closed'),
          physicalLabel: !known ? 'Sin dato' : (relayOn ? 'Abierta' : 'Cerrada'),
          raw: status.raw || null,
          queriedAt: status.queriedAt || new Date().toISOString()
        });
      }
    } catch (err) {
      const message = friendlyBridgeError(err);
      boardErrors.push({ host: board.host, message });
      for (const item of board.doorIds) {
        doorsStatus.push({
          doorId: item.doorId,
          doorName: item.doorName,
          host: board.host,
          channel: item.channel,
          relayMode: 'cloud',
          relayOn: null,
          physicalState: 'error',
          physicalLabel: 'Sin conexión',
          error: message,
          queriedAt: new Date().toISOString()
        });
      }
    }
  }

  return {
    ok: boardErrors.length === 0,
    message: boardErrors.length
      ? `No se pudo leer el estado a distancia (${boardErrors.length})`
      : 'Estado físico actualizado',
    doors: doorsStatus,
    boardErrors
  };
};

module.exports = {
  describeRelayConfirmation,
  buildRelayConfigForDoor,
  isDoorRelayConfigured,
  getAirlockState,
  resetAirlockState,
  openDoor,
  resolveDoorContext,
  listActiveDoors,
  getDoorsPhysicalStatus,
  evaluateAirlockForOpen,
  evaluateAirlockPhase,
  evaluateManualAirlockPhase,
  deriveAirlockPhase,
  reserveDoorOpen,
  MANUAL_COOLDOWN_MS
};
