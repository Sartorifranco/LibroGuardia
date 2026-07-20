const { db, FieldValue } = require('../firestore');

const DOORS_SETTINGS_DOC = 'doorsConfig';

const AUTH_METHODS = ['dni', 'face', 'credential', 'manual'];

const DOOR_DRIVERS = ['sr201', 'generic_http'];

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
  authMethods: ['dni', 'credential'],
  readerIds: ['default'],
  kioskEnabled: true,
  manualOpenAllowed: true,
  autoOpenOnAuth: true,
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

const normalizeDoor = (door = {}, index = 0) => {
  const id = slugifyDoorId(door.id || door.name) || `puerta-${index + 1}`;
  return {
    ...DEFAULT_DOOR,
    ...door,
    id,
    name: String(door.name || id).trim(),
    active: door.active !== false,
    device: normalizeDevice(door.device),
    pulseMode: ['inherit', 'jog', 'timed'].includes(door.pulseMode) ? door.pulseMode : 'inherit',
    pulseSeconds: Number(door.pulseSeconds) || DEFAULT_DOOR.pulseSeconds,
    authMethods: normalizeAuthMethods(door.authMethods),
    readerIds: Array.isArray(door.readerIds) && door.readerIds.length
      ? door.readerIds.map((item) => String(item).trim()).filter(Boolean)
      : ['default'],
    kioskEnabled: door.kioskEnabled !== false,
    manualOpenAllowed: door.manualOpenAllowed !== false,
    autoOpenOnAuth: door.autoOpenOnAuth !== false,
    airlockGroupId: door.airlockGroupId || null,
    airlockRole: ['outer', 'inner'].includes(door.airlockRole) ? door.airlockRole : null,
    sequenceOrder: Number(door.sequenceOrder) || 0
  };
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

const normalizeDoorsConfig = (raw = {}, accessControl = {}) => {
  const doors = (raw.doors || []).map(normalizeDoor);
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
    payload.doors = (updates.doors || []).map(normalizeDoor);
  }
  if (updates.airlockGroups !== undefined) {
    payload.airlockGroups = (updates.airlockGroups || []).map(normalizeAirlockGroup);
  }

  await db.collection('settings').doc(DOORS_SETTINGS_DOC).set(payload, { merge: true });
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
      && door.readerIds.includes(reader)
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
  DOOR_DRIVERS,
  DEFAULT_DOOR,
  DEFAULT_AIRLOCK_GROUP,
  DEFAULT_DOORS_CONFIG,
  slugifyDoorId,
  normalizeDoorsConfig,
  getDoorsConfig,
  getDoorsConfigMeta,
  saveDoorsConfig,
  findDoorById,
  findDoorByReader,
  findAirlockGroup,
  getAirlockDoors
};
