const { db, FieldValue } = require('../firestore');

const DOORS_SETTINGS_DOC = 'doorsConfig';

const AUTH_METHODS = ['dni', 'face', 'credential', 'manual', 'biometric'];

const DOOR_DRIVERS = ['sr201', 'generic_http'];

const READER_DIRECTIONS = ['ingreso', 'egreso', 'ambos'];

/**
 * Quién dispara físicamente el relé de la puerta:
 *   'cloud' → la Cloud Function (driver directo / túnel). Comportamiento actual.
 *   'local' → la mini PC de la puerta (door-reader-bridge) dispara por la LAN.
 */
const RELAY_MODES = ['cloud', 'local'];

/** Tipo que ve la persona: puerta, portón o molinete. */
const DOOR_KINDS = ['door', 'gate', 'turnstile'];

/**
 * Prefijo de lector en la lectura USB (diagrama planta):
 *   INGRESO_P1#30111222  → readerId=INGRESO_P1, payload=30111222
 *   EGRESO_P1#30111222
 * También acepta "INGRESO_P1:..." o "INGRESO_P1 ...".
 */
const READER_PREFIX_RE = /^(INGRESO|EGRESO)[_-]([A-Za-z0-9_-]+)[#:\s]+([\s\S]+)$/i;

const parseReaderPrefixedScan = (rawData = '') => {
  const trimmed = String(rawData || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(READER_PREFIX_RE);
  if (!match) return null;
  const sense = match[1].toUpperCase() === 'EGRESO' ? 'egreso' : 'ingreso';
  const doorCode = String(match[2] || '').trim();
  const readerId = `${sense === 'egreso' ? 'EGRESO' : 'INGRESO'}_${doorCode}`;
  return {
    readerId,
    direction: sense,
    doorCode,
    payload: String(match[3] || '').trim(),
    rawPrefix: trimmed.slice(0, trimmed.length - match[3].length)
  };
};

const DEFAULT_DOOR = {
  id: '',
  name: '',
  active: true,
  device: {
    driver: 'sr201',
    bridgeUrl: '',
    bridgeSecret: '',
    host: '',
    port: 6722,
    channel: 1,
    httpUrl: '',
    httpMethod: 'POST',
    httpAuthToken: ''
  },
  pulseMode: 'inherit',
  pulseSeconds: 3,
  relayMode: 'cloud',
  authMethods: ['dni', 'credential'],
  readerIds: ['default'],
  /** Lectores con dirección fija opcional. direction: ingreso | egreso | ambos */
  readers: [{ id: 'default', direction: 'ambos' }],
  kioskEnabled: true,
  manualOpenAllowed: true,
  autoOpenOnAuth: true,
  /** Ingreso principal: al escanear DNI se avisa al guardia con foto (si el feature está activo). */
  isMainEntryDoor: false,
  airlockGroupId: null,
  airlockRole: null,
  sequenceOrder: 0
};

const DEFAULT_AIRLOCK_GROUP = {
  id: '',
  name: '',
  doorIds: [],
  enabled: true,
  mode: 'sequential_closed',
  outerCloseDelayMs: 5000,
  interDoorDelayMs: 2000,
  transitTimeoutMs: 120000,
  requireInnerAuth: true
};

const DEFAULT_DOORS_CONFIG = {
  version: 1,
  defaultDoorId: null,
  doors: [],
  airlockGroups: []
};

const slugifyDoorId = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

const normalizeAuthMethods = (methods = []) => {
  const list = Array.isArray(methods) ? methods : [];
  const normalized = [...new Set(list.filter((item) => AUTH_METHODS.includes(item)))];
  return normalized.length ? normalized : ['dni'];
};

const normalizeDevice = (device = {}) => {
  const merged = {
    ...DEFAULT_DOOR.device,
    ...(device || {})
  };
  const driver = DOOR_DRIVERS.includes(merged.driver) ? merged.driver : 'sr201';
  const httpMethod = String(merged.httpMethod || 'POST').toUpperCase();
  return {
    ...merged,
    driver,
    bridgeUrl: String(merged.bridgeUrl || '').trim(),
    bridgeSecret: String(merged.bridgeSecret || ''),
    host: String(merged.host || '').trim(),
    port: Number(merged.port) || DEFAULT_DOOR.device.port,
    channel: Number(merged.channel) || DEFAULT_DOOR.device.channel,
    httpUrl: String(merged.httpUrl || '').trim(),
    httpMethod: ['POST', 'PUT', 'GET'].includes(httpMethod) ? httpMethod : 'POST',
    httpAuthToken: String(merged.httpAuthToken || '')
  };
};

/**
 * Normaliza readers[{id,direction}] y sincroniza readerIds (compat).
 * Si solo vienen readerIds, cada uno queda con direction 'ambos'.
 * Si vienen readers y readerIds, se prioriza el orden de readerIds y se
 * conservan directions conocidas por id.
 */
const normalizeReaders = (door = {}) => {
  const prevById = new Map();
  if (Array.isArray(door.readers)) {
    door.readers.forEach((item) => {
      const id = String(item?.id || '').trim();
      if (!id) return;
      const direction = READER_DIRECTIONS.includes(item.direction) ? item.direction : 'ambos';
      prevById.set(id, { id, direction });
    });
  }

  let ids = [];
  if (Array.isArray(door.readerIds) && door.readerIds.length) {
    ids = door.readerIds.map((item) => String(item).trim()).filter(Boolean);
  } else if (prevById.size) {
    ids = [...prevById.keys()];
  } else {
    ids = ['default'];
  }

  const readers = ids.map((id) => {
    const prev = prevById.get(id);
    return {
      id,
      direction: prev?.direction && READER_DIRECTIONS.includes(prev.direction)
        ? prev.direction
        : 'ambos'
    };
  });

  return {
    readers,
    readerIds: readers.map((r) => r.id)
  };
};

/** Dirección configurada del reader, o 'ambos' si no existe. */
const getReaderDirection = (door, readerId = 'default') => {
  const id = String(readerId || 'default').trim() || 'default';
  const readers = Array.isArray(door?.readers) ? door.readers : [];
  const match = readers.find((r) => r.id === id);
  if (match && READER_DIRECTIONS.includes(match.direction)) return match.direction;
  return 'ambos';
};

/**
 * Si el reader tiene direction fija ingreso|egreso, la devuelve.
 * Si es 'ambos' o no está, null → el caller debe inferir.
 */
const resolveReaderFixedMovement = (door, readerId = 'default') => {
  const direction = getReaderDirection(door, readerId);
  if (direction === 'ingreso' || direction === 'egreso') return direction;
  return null;
};

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

/**
 * Lados de la puerta: entrar va de A a B y salir de B a A.
 * strict: al guardar, dos lugares iguales es un error. Al leer, se descarta.
 */
const normalizeSides = (sides, { strict = false } = {}) => {
  if (!sides || typeof sides !== 'object' || Array.isArray(sides)) return null;
  const inn = sides.in && typeof sides.in === 'object' ? sides.in : {};
  const out = sides.out && typeof sides.out === 'object' ? sides.out : {};
  const zoneFrom = slugifyDoorId(inn.zoneFrom || '');
  const zoneTo = slugifyDoorId(inn.zoneTo || '');
  if (!zoneFrom || !zoneTo) return null;
  if (zoneFrom === zoneTo) {
    if (strict) throw httpError(400, 'Los dos lados de la puerta tienen que ser lugares distintos.');
    return null;
  }
  const outFrom = slugifyDoorId(out.zoneFrom || '') || zoneTo;
  const outTo = slugifyDoorId(out.zoneTo || '') || zoneFrom;
  return {
    in: { zoneFrom, zoneTo },
    out: { zoneFrom: outFrom, zoneTo: outTo }
  };
};

const normalizeDoor = (door = {}, index = 0, { strict = false } = {}) => {
  const id = slugifyDoorId(door.id || door.name) || `puerta-${index + 1}`;
  const { readers, readerIds } = normalizeReaders(door);
  // Campos solo de UI / enriquecimiento — no persistir en settings.
  const {
    localStation: _ls,
    _localId: _lid,
    doorCode: _dc,
    ...persistable
  } = door;
  const normalized = {
    ...DEFAULT_DOOR,
    ...persistable,
    id,
    name: String(door.name || id).trim(),
    active: door.active !== false,
    device: normalizeDevice(door.device),
    pulseMode: ['inherit', 'jog', 'timed'].includes(door.pulseMode) ? door.pulseMode : 'inherit',
    pulseSeconds: Number(door.pulseSeconds) || DEFAULT_DOOR.pulseSeconds,
    relayMode: door.relayMode === 'local' ? 'local' : 'cloud',
    authMethods: normalizeAuthMethods(door.authMethods),
    readers,
    readerIds,
    kioskEnabled: door.kioskEnabled !== false,
    manualOpenAllowed: door.manualOpenAllowed !== false,
    autoOpenOnAuth: door.autoOpenOnAuth !== false,
    isMainEntryDoor: door.isMainEntryDoor === true,
    airlockGroupId: door.airlockGroupId || null,
    airlockRole: ['outer', 'inner'].includes(door.airlockRole) ? door.airlockRole : null,
    sequenceOrder: Number(door.sequenceOrder) || 0
  };
  const repeatRaw = door.repeatWindowSec;
  if (repeatRaw == null || repeatRaw === '') delete normalized.repeatWindowSec;
  else {
    const repeat = Number(repeatRaw);
    if (Number.isFinite(repeat) && repeat >= 0) normalized.repeatWindowSec = Math.round(repeat);
    else delete normalized.repeatWindowSec;
  }

  delete normalized.placeA;
  delete normalized.placeB;
  delete normalized.airlockEnabled;
  delete normalized.airlockPartnerId;

  normalized.kind = DOOR_KINDS.includes(door.kind) ? door.kind : 'door';
  const sides = normalizeSides(door.sides, { strict });
  if (sides) normalized.sides = sides;
  else delete normalized.sides;

  if (typeof door.sensorsRequired === 'boolean') normalized.sensorsRequired = door.sensorsRequired;
  else delete normalized.sensorsRequired;

  if (door.requireGuardApproval === true) normalized.requireGuardApproval = true;
  else if (door.requireGuardApproval === false) normalized.requireGuardApproval = false;
  else delete normalized.requireGuardApproval;

  const heldRaw = door.heldOpenSec;
  if (normalized.sensorsRequired === true && heldRaw != null && heldRaw !== '') {
    const held = Number(heldRaw);
    if (!Number.isFinite(held) || held < 10 || held > 600) {
      if (strict) throw httpError(400, 'El aviso de puerta abierta tiene que estar entre 10 y 600 segundos.');
      delete normalized.heldOpenSec;
    } else normalized.heldOpenSec = Math.round(held);
  } else delete normalized.heldOpenSec;

  const unlock = Number(door.unlockSec);
  normalized.unlockSec = Number.isFinite(unlock) && unlock > 0
    ? Math.min(60, Math.round(unlock))
    : normalized.pulseSeconds;

  return normalized;
};

const normalizeAirlockGroup = (group = {}, index = 0) => {
  const id = slugifyDoorId(group.id || group.name) || `estanco-${index + 1}`;
  return {
    ...DEFAULT_AIRLOCK_GROUP,
    ...group,
    id,
    name: String(group.name || id).trim(),
    enabled: group.enabled !== false,
    doorIds: Array.isArray(group.doorIds) ? group.doorIds.filter(Boolean) : [],
    mode: group.mode === 'sequential_closed' ? 'sequential_closed' : 'sequential_closed',
    outerCloseDelayMs: Math.max(1000, Number(group.outerCloseDelayMs) || DEFAULT_AIRLOCK_GROUP.outerCloseDelayMs),
    interDoorDelayMs: Math.max(0, Number(group.interDoorDelayMs) || DEFAULT_AIRLOCK_GROUP.interDoorDelayMs),
    transitTimeoutMs: Math.max(10000, Number(group.transitTimeoutMs) || DEFAULT_AIRLOCK_GROUP.transitTimeoutMs),
    requireInnerAuth: group.requireInnerAuth !== false
  };
};

const buildLegacyDefaultDoor = (accessControl = {}) => normalizeDoor({
  id: 'puerta-principal',
  name: 'Puerta principal',
  device: {
    driver: 'sr201',
    bridgeUrl: accessControl.bridgeUrl || '',
    bridgeSecret: accessControl.bridgeSecret || '',
    host: accessControl.host || '',
    port: accessControl.port || 6722,
    channel: accessControl.relayChannel || 1
  },
  pulseMode: accessControl.pulseMode || 'inherit',
  pulseSeconds: accessControl.pulseSeconds || 3,
  readerIds: ['default'],
  authMethods: ['dni', 'credential', 'manual']
});

const normalizeDoorsConfig = (raw = {}, accessControl = {}, { strict = false } = {}) => {
  const doors = (raw.doors || []).map((door, index) => normalizeDoor(door, index, { strict }));
  const airlockGroups = (raw.airlockGroups || []).map(normalizeAirlockGroup);
  const resolvedDoors = doors.length ? doors : [buildLegacyDefaultDoor(accessControl)];

  return {
    ...DEFAULT_DOORS_CONFIG,
    ...raw,
    version: 1,
    defaultDoorId: raw.defaultDoorId || resolvedDoors[0]?.id || null,
    doors: resolvedDoors,
    airlockGroups
  };
};

const getDoorsConfig = async (accessControl = null) => {
  const snap = await db.collection('settings').doc(DOORS_SETTINGS_DOC).get();
  const data = snap.exists ? snap.data() : {};
  let globalAccess = accessControl;
  if (!globalAccess) {
    const accessSnap = await db.collection('settings').doc('accessControl').get();
    globalAccess = accessSnap.exists ? accessSnap.data() : {};
  }
  return normalizeDoorsConfig(data, globalAccess);
};

const saveDoorsConfig = async (updates = {}) => {
  const payload = {
    version: 1,
    updatedAt: FieldValue.serverTimestamp()
  };

  if (updates.defaultDoorId !== undefined) payload.defaultDoorId = updates.defaultDoorId || null;
  if (updates.doors !== undefined) {
    payload.doors = (updates.doors || []).map((door, index) => normalizeDoor(door, index, { strict: true }));
  }
  if (updates.airlockGroups !== undefined) {
    payload.airlockGroups = (updates.airlockGroups || []).map(normalizeAirlockGroup);
  }

  // Evitar defaultDoorId huérfano (causa 404 en “Abrir puerta”).
  if (payload.doors) {
    const ids = new Set(payload.doors.filter((d) => d.active !== false).map((d) => d.id));
    const preferred = payload.defaultDoorId !== undefined
      ? payload.defaultDoorId
      : updates.defaultDoorId;
    if (preferred && ids.has(preferred)) {
      payload.defaultDoorId = preferred;
    } else if (ids.size) {
      payload.defaultDoorId = [...ids][0];
    } else {
      payload.defaultDoorId = null;
    }
  }

  await db.collection('settings').doc(DOORS_SETTINGS_DOC).set(payload, { merge: true });
  try {
    const { bumpDoorsVersion } = require('./dataVersions');
    await bumpDoorsVersion();
  } catch (err) {
    console.warn('[doorsConfig] bumpDoorsVersion', err.message);
  }
  return getDoorsConfig();
};

const getDoorsConfigMeta = async () => {
  const snap = await db.collection('settings').doc(DOORS_SETTINGS_DOC).get();
  const storedDoors = snap.exists && Array.isArray(snap.data()?.doors) ? snap.data().doors : [];
  return {
    hasStoredDoors: storedDoors.length > 0,
    storedDoorCount: storedDoors.length
  };
};

const findDoorById = (config, doorId) =>
  (config?.doors || []).find((door) => door.id === doorId && door.active !== false) || null;

const findDoorByReader = (config, readerId = 'default') => {
  const reader = String(readerId || 'default').trim() || 'default';
  const match = (config?.doors || []).find(
    (door) => door.active !== false
      && door.kioskEnabled !== false
      && (
        (Array.isArray(door.readerIds) && door.readerIds.includes(reader))
        || (Array.isArray(door.readers) && door.readers.some((r) => r.id === reader))
      )
  );
  if (match) return match;
  const defaultDoor = findDoorById(config, config.defaultDoorId);
  if (defaultDoor) return defaultDoor;
  return (config?.doors || []).find((door) => door.active !== false) || null;
};

const findAirlockGroup = (config, groupId) =>
  (config?.airlockGroups || []).find((group) => group.id === groupId && group.enabled !== false) || null;

const getAirlockDoors = (config, groupId) => {
  const group = findAirlockGroup(config, groupId);
  if (!group) return [];
  return group.doorIds
    .map((doorId) => findDoorById(config, doorId))
    .filter(Boolean);
};

module.exports = {
  AUTH_METHODS,
  DOOR_KINDS,
  DOOR_DRIVERS,
  READER_DIRECTIONS,
  RELAY_MODES,
  DEFAULT_DOOR,
  DEFAULT_AIRLOCK_GROUP,
  DEFAULT_DOORS_CONFIG,
  slugifyDoorId,
  normalizeDoorsConfig,
  normalizeReaders,
  getReaderDirection,
  resolveReaderFixedMovement,
  parseReaderPrefixedScan,
  getDoorsConfig,
  getDoorsConfigMeta,
  saveDoorsConfig,
  findDoorById,
  findDoorByReader,
  findAirlockGroup,
  getAirlockDoors
};
