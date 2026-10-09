/**
 * Asigna puertas de settings/doorsConfig a un controlador (controllerId).
 * Las dos puertas de un estanco tienen que quedar en el mismo equipo.
 * Si la puerta ya está en otro, hay que confirmar el pase.
 */

const { db, FieldValue } = require('../firestore');
const { httpError, DEVICES_COLLECTION, DEFAULT_SITE_ID, sanitizeDoorIds } = require('./devices');
const { markDirty } = require('./siteCompiler');

/** Escribe las puertas sin renormalizar (no cambia ids ni el resto de la config). */
const writeDoors = async (doors) => {
  await db.collection('settings').doc('doorsConfig').set({
    doors,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  try {
    const { bumpDoorsVersion } = require('./dataVersions');
    await bumpDoorsVersion();
  } catch (err) {
    console.warn('[deviceDoors] bumpDoorsVersion', err.message);
  }
};

const readDoorsSettings = async () => {
  const snap = await db.collection('settings').doc('doorsConfig').get();
  const data = snap.exists ? (snap.data() || {}) : {};
  return {
    doors: Array.isArray(data.doors) ? data.doors : [],
    groups: groupsOf(data)
  };
};

const groupsOf = (data = {}) => {
  const raw = [
    ...(Array.isArray(data.airlockGroups) ? data.airlockGroups : []),
    ...(Array.isArray(data.interlockGroups) ? data.interlockGroups : [])
  ];
  const out = [];
  const seen = new Set();
  raw.forEach((group) => {
    if (!group || group.enabled === false) return;
    const doorIds = [...new Set((group.doorIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (doorIds.length < 2) return;
    const id = String(group.id || group.name || `estanco-${out.length + 1}`);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: String(group.name || group.id || 'Estanco'),
      doorIds
    });
  });
  return out;
};

const doorName = (doors, id) => {
  const door = doors.find((item) => item && String(item.id) === String(id));
  return (door && door.name) || id;
};

const activeOwner = (device) => device && device.status !== 'replaced' && device.status !== 'revoked';

/**
 * Puertas y estancos para el asistente (una lectura de doorsConfig + equipos ya listados aparte).
 */
const doorCatalog = async () => {
  const { doors, groups } = await readDoorsSettings();
  const groupByDoor = new Map();
  groups.forEach((group) => {
    group.doorIds.forEach((id) => {
      if (!groupByDoor.has(id)) groupByDoor.set(id, group);
    });
  });
  return {
    doors: doors.map((door) => {
      const group = groupByDoor.get(String(door.id));
      return {
        id: String(door.id),
        name: door.name || String(door.id),
        controllerId: door.controllerId || null,
        groupId: group ? group.id : null,
        groupName: group ? group.name : null
      };
    }),
    airlocks: groups
  };
};

const loadDeviceMap = async () => {
  const snap = await db.collection(DEVICES_COLLECTION).limit(500).get();
  const map = new Map();
  snap.docs.forEach((doc) => map.set(doc.id, { id: doc.id, ...(doc.data() || {}) }));
  return map;
};

const ownerOfDoor = (door, devices, doorId) => {
  const pointed = door && door.controllerId ? String(door.controllerId) : '';
  if (pointed && devices.has(pointed)) return devices.get(pointed);
  for (const device of devices.values()) {
    if (!activeOwner(device)) continue;
    const ids = Array.isArray(device.doorIds) ? device.doorIds.map(String) : [];
    if (ids.includes(String(doorId))) return device;
  }
  if (pointed) return { id: pointed, name: pointed, status: 'active', kind: 'controller' };
  return null;
};

/**
 * Valida el conjunto de puertas. No escribe.
 * @throws 400 AIRLOCK_SPLIT | 409 DOOR_MOVE_CONFIRM
 */
const validateAssignment = async ({ doorIds, confirmMoves = false, deviceId = null } = {}) => {
  const doorsWanted = sanitizeDoorIds(doorIds);
  if (!doorsWanted.length) return { doorIds: [], moves: [], link: false };
  const { doors, groups } = await readDoorsSettings();
  // Sin puertas cargadas, el alta vieja solo anota doorIds (el instalador local).
  if (!doors.length) return { doorIds: doorsWanted, moves: [], link: false };
  const known = new Set(doors.map((door) => String(door.id)));
  const missingDoor = doorsWanted.find((id) => !known.has(id));
  if (missingDoor) throw httpError(400, `No existe la puerta ${missingDoor}`, 'DOOR_NOT_FOUND');

  for (const group of groups) {
    const selected = group.doorIds.filter((id) => doorsWanted.includes(id));
    if (!selected.length || selected.length === group.doorIds.length) continue;
    const missing = group.doorIds
      .filter((id) => !doorsWanted.includes(id))
      .map((id) => doorName(doors, id));
    const noun = group.doorIds.length === 2 ? 'Las dos puertas' : 'Todas las puertas';
    throw httpError(
      400,
      `${noun} del estanco «${group.name}» tienen que quedar en el mismo equipo. Sumá también ${missing.join(' y ')}.`,
      'AIRLOCK_SPLIT'
    );
  }

  const devices = await loadDeviceMap();
  const selfId = deviceId ? String(deviceId) : '';
  const moves = [];
  doorsWanted.forEach((id) => {
    const door = doors.find((item) => String(item.id) === id);
    const owner = ownerOfDoor(door, devices, id);
    if (!owner || owner.id === selfId) return;
    if (owner.status === 'replaced') return;
    const name = owner.name || owner.id;
    moves.push({
      doorId: id,
      doorName: doorName(doors, id),
      fromDeviceId: owner.id,
      fromDeviceName: name,
      message: `Esta puerta pasa del equipo ${name} al nuevo`
    });
  });
  if (moves.length && !confirmMoves) {
    const err = httpError(409, moves.map((move) => move.message).join(' '), 'DOOR_MOVE_CONFIRM');
    err.moves = moves;
    throw err;
  }
  return { doorIds: doorsWanted, moves, link: true };
};

const applyAssignment = async ({ deviceId, doorIds, by = null } = {}) => {
  const id = String(deviceId || '').trim();
  const plan = await validateAssignment({ doorIds, confirmMoves: true, deviceId: id });
  if (!plan.link) {
    return { doorIds: plan.doorIds, moves: [], beforeDoorIds: [], linked: false, by };
  }
  const snap = await db.collection('settings').doc('doorsConfig').get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const doors = Array.isArray(data.doors) ? data.doors.map((door) => ({ ...door })) : [];
  const wanted = new Set(plan.doorIds);
  const beforeIds = [];
  doors.forEach((door) => {
    if (String(door.controllerId || '') === id) beforeIds.push(String(door.id));
    if (wanted.has(String(door.id))) door.controllerId = id;
    else if (String(door.controllerId || '') === id) door.controllerId = null;
  });
  await writeDoors(doors);

  const devices = await loadDeviceMap();
  const touched = new Set(plan.moves.map((move) => move.fromDeviceId));
  for (const otherId of touched) {
    if (!otherId || otherId === id || !devices.has(otherId)) continue;
    const other = devices.get(otherId);
    const next = (Array.isArray(other.doorIds) ? other.doorIds : [])
      .map(String)
      .filter((doorId) => !wanted.has(doorId));
    // eslint-disable-next-line no-await-in-loop
    await db.collection(DEVICES_COLLECTION).doc(otherId).set({
      doorIds: next,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  const self = devices.get(id);
  await db.collection(DEVICES_COLLECTION).doc(id).set({
    doorIds: plan.doorIds,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await markDirty((self && self.siteId) || DEFAULT_SITE_ID, { doors: true });
  return {
    doorIds: plan.doorIds,
    moves: plan.moves,
    beforeDoorIds: beforeIds,
    linked: true,
    by
  };
};

/** Tras reemplazar: las puertas siguen, pero las atiende el equipo nuevo. */
const retargetDoors = async (fromId, toId) => {
  const from = String(fromId || '');
  const to = String(toId || '');
  if (!from || !to || from === to) return false;
  const snap = await db.collection('settings').doc('doorsConfig').get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const doors = Array.isArray(data.doors) ? data.doors : [];
  let changed = false;
  const next = doors.map((door) => {
    if (String(door.controllerId || '') !== from) return door;
    changed = true;
    return { ...door, controllerId: to };
  });
  if (changed) await writeDoors(next);
  await db.collection(DEVICES_COLLECTION).doc(from).set({
    doorIds: [],
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  if (changed) await markDirty(DEFAULT_SITE_ID, { doors: true });
  return changed;
};

/** Dar de baja: las puertas dejan de apuntar a un equipo que ya no funciona. */
const clearDoors = async (deviceId) => {
  const id = String(deviceId || '');
  const snap = await db.collection('settings').doc('doorsConfig').get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const doors = Array.isArray(data.doors) ? data.doors : [];
  let changed = false;
  const next = doors.map((door) => {
    if (String(door.controllerId || '') !== id) return door;
    changed = true;
    return { ...door, controllerId: null };
  });
  if (changed) await writeDoors(next);
  await db.collection(DEVICES_COLLECTION).doc(id).set({
    doorIds: [],
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  if (changed) await markDirty(DEFAULT_SITE_ID, { doors: true });
  return changed;
};

module.exports = {
  doorCatalog,
  validateAssignment,
  applyAssignment,
  retargetDoors,
  clearDoors,
  groupsOf
};
