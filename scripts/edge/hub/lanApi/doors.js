'use strict';

/**
 * Puertas del puesto (D6). `posts` vacío = todas las habilitadas.
 * Si hay puestos, la puerta entra cuando alguno coincide (sin acentos ni mayúsculas)
 * con id, post, postId, puesto o nombre.
 *
 * `live.since` es epoch ms (igual que door_state). La fase del estanco se aproxima
 * con el estado de las puertas; quien decide el 409 es el controlador.
 */

const { hasPerm } = require('./operators');

const LIVE_STATES = new Set(['SEGURA', 'DESBLOQUEADA', 'ABIERTA_AUT', 'RETENIDA', 'FORZADA', 'FALLA', 'SIN_CONEXION']);

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function doorVisible(op, door) {
  const posts = op && Array.isArray(op.posts) ? op.posts : [];
  if (!posts.length) return true;
  const keys = new Set([
    fold(door.id),
    fold(door.post),
    fold(door.postId),
    fold(door.puesto),
    fold(door.name)
  ].filter(Boolean));
  return posts.some((p) => keys.has(fold(p)));
}

function parseDoor(row) {
  let json = {};
  try { json = JSON.parse(row.json) || {}; } catch (_) { json = {}; }
  return { ...json, id: row.id };
}

function loadGroups(db) {
  const groups = [];
  for (const row of db.all('SELECT id, json FROM interlocks ORDER BY id')) {
    try {
      const g = JSON.parse(row.json);
      if (g) groups.push({ ...g, id: g.id || row.id });
    } catch (_) { /* grupo ilegible: se omite */ }
  }
  return groups;
}

function groupFor(groups, doorId) {
  return groups.find((g) => (g.doorIds || g.doors || []).map(String).includes(String(doorId))) || null;
}

function phaseOf(doorId, group, stateOf) {
  if (!group) return null;
  const ids = (group.doorIds || []).map(String);
  const openish = (id) => {
    const st = stateOf(id);
    return Boolean(st) && st !== 'SEGURA' && st !== 'SIN_CONEXION';
  };
  if (ids.some((id) => id !== String(doorId) && openish(id))) return 'other_open';
  if (openish(doorId)) return 'this_open';
  return 'idle';
}

function healthOf(state, controllerOnline) {
  if (controllerOnline === false || state === 'SIN_CONEXION') {
    return { status: 'offline', reason: 'El controlador no responde' };
  }
  if (state === 'FALLA') return { status: 'problem', reason: 'Falla de sensor o cerradura' };
  if (state === 'FORZADA') return { status: 'problem', reason: 'Puerta forzada' };
  if (state === 'RETENIDA') return { status: 'problem', reason: 'Puerta abierta demasiado tiempo' };
  return { status: 'online', reason: null };
}

function authMethodsOf(door) {
  if (Array.isArray(door.authMethods) && door.authMethods.length) return door.authMethods;
  return ['dni'];
}

function latestPulses(db) {
  const map = new Map();
  const rows = db.all(
    `SELECT door_id, ts, type, decision, payload_json FROM (
       SELECT door_id, ts, type, decision, payload_json,
              ROW_NUMBER() OVER (PARTITION BY door_id ORDER BY ts DESC, id DESC) AS rn
       FROM events
       WHERE door_id IS NOT NULL AND type IN ('manual_open','remote_open','access','passage')
     ) WHERE rn = 1`
  );
  for (const row of rows) map.set(row.door_id, row);
  const queued = new Map();
  const cmds = db.all(
    "SELECT door_id, ts, status FROM commands WHERE door_id IS NOT NULL AND status IN ('running','pending') ORDER BY ts DESC"
  );
  for (const row of cmds) {
    if (!queued.has(row.door_id)) queued.set(row.door_id, row);
  }
  return { map, queued };
}

function lastPulseOf(pulse, queued) {
  if (queued && (!pulse || Number(queued.ts) >= Number(pulse.ts))) {
    return { at: new Date(Number(queued.ts)).toISOString(), relayStatus: 'en_cola', relayConfirmed: false };
  }
  if (!pulse) return null;
  let payload = {};
  try { payload = pulse.payload_json ? JSON.parse(pulse.payload_json) : {}; } catch (_) { payload = {}; }
  let relayStatus = 'sin_confirmacion';
  let relayConfirmed = false;
  if (payload.relayConfirmed === true || payload.relayStatus === 'confirmado') {
    relayStatus = 'confirmado';
    relayConfirmed = true;
  } else if (payload.relayStatus === 'en_cola' || payload.queued === true) {
    relayStatus = 'en_cola';
  }
  return { at: new Date(Number(pulse.ts)).toISOString(), relayStatus, relayConfirmed };
}

function presentDoor(door, { stateRow, controllerOnline, group, stateOf, pulse, queued }) {
  const rawState = stateRow && stateRow.state;
  let state = controllerOnline === false ? 'SIN_CONEXION' : (rawState || 'SEGURA');
  if (!LIVE_STATES.has(state)) state = controllerOnline === false ? 'SIN_CONEXION' : 'SEGURA';
  const enabled = door.enabled !== false && door.active !== false;
  const out = {
    id: door.id,
    name: door.name || door.id,
    active: enabled,
    enabled,
    manualOpenAllowed: enabled && door.manualOpenAllowed !== false,
    authMethods: authMethodsOf(door),
    isMainEntryDoor: door.isMainEntryDoor === true,
    sides: door.sides || null,
    readers: Array.isArray(door.readers) ? door.readers : [],
    unlockSec: door.unlockSec ?? null,
    pulseSeconds: door.pulseSeconds ?? door.unlockSec ?? null,
    heldOpenSec: door.heldOpenSec ?? null,
    requireGuardApproval: door.requireGuardApproval === true,
    controllerId: door.controllerId || null,
    relayMode: (door.output && door.output.relayMode) || door.relayMode || null,
    live: {
      state,
      dps: stateRow ? stateRow.dps ?? null : null,
      bond: stateRow ? stateRow.bond ?? null : null,
      since: stateRow && stateRow.since != null ? Number(stateRow.since) : null
    },
    health: healthOf(state, controllerOnline),
    lastPulse: lastPulseOf(pulse, queued)
  };
  if (group) out.airlock = { groupId: group.id, phase: phaseOf(door.id, group, stateOf) };
  return out;
}

function listGuardDoors(hub, op) {
  if (!hasPerm(op, 'access.manual_open')) {
    return { status: 403, body: { message: 'No tenés permiso para ver las puertas.' } };
  }
  const db = hub.edge.db;
  hub.edge.snapshot.refresh();
  const groups = loadGroups(db);
  const states = new Map(db.all('SELECT door_id, state, since, dps, bond FROM door_state').map((r) => [r.door_id, r]));
  const ctl = hub.controllers ? hub.controllers.summary() : {};
  const pulses = latestPulses(db);
  const stateName = (id, door) => {
    const ctlId = door && door.controllerId;
    const online = ctlId && ctl[ctlId] ? ctl[ctlId].online === true : ctlId ? false : null;
    if (online === false) return 'SIN_CONEXION';
    const row = states.get(id);
    return row && row.state ? row.state : 'SEGURA';
  };
  const doors = [];
  const doorById = new Map();
  for (const row of db.all('SELECT id, json FROM doors ORDER BY id')) {
    const door = parseDoor(row);
    doorById.set(door.id, door);
  }
  const named = (id) => stateName(id, doorById.get(id));
  for (const door of doorById.values()) {
    if (door.enabled === false || door.active === false) continue;
    if (!doorVisible(op, door)) continue;
    const ctlId = door.controllerId || null;
    const known = ctlId ? ctl[ctlId] : null;
    const controllerOnline = known ? known.online === true : (ctlId ? false : null);
    const group = groupFor(groups, door.id);
    doors.push(presentDoor(door, {
      stateRow: states.get(door.id) || null,
      controllerOnline,
      group,
      stateOf: named,
      pulse: pulses.map.get(door.id) || null,
      queued: pulses.queued.get(door.id) || null
    }));
  }
  return {
    status: 200,
    body: {
      defaultDoorId: doors[0] ? doors[0].id : null,
      doors,
      airlockGroups: groups.map((g) => ({
        id: g.id,
        name: g.name || g.id,
        doorIds: g.doorIds || [],
        mode: g.mode || 'sensor'
      }))
    }
  };
}

module.exports = { listGuardDoors, doorVisible, fold };
