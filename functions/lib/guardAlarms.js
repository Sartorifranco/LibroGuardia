/**
 * Alarmas de sites/{s}/alarms en la misma forma que el hub LAN
 * (scripts/edge/hub/lanApi/alarms.js): { alerts, queriedAt } y ack { ok }.
 */

const { db, FieldValue } = require('../firestore');
const { httpError, DEFAULT_SITE_ID, sanitizeSiteId } = require('./devices');

const TITLES = {
  door_forced: 'Puerta forzada',
  held_open: 'Abierta demasiado tiempo',
  lock_fault: 'Falla de cerradura',
  duress: 'Coacción',
  device_offline: 'Equipo sin conexión',
  tamper: 'Manipulación del equipo',
  apertura_forzada_estanco: 'Estanco',
  hub_offline: 'Central sin conexión',
  config_stale: 'Configuración desactualizada',
  emergency: 'Emergencia',
  interlock_violation: 'Estanco',
  tailgate: 'Posible colado',
  credential_key_missing: 'Falta la clave de credenciales'
};

const ERROR_TYPES = new Set([
  'door_forced', 'lock_fault', 'duress', 'tamper', 'emergency', 'interlock_violation', 'apertura_forzada_estanco'
]);

const toMillis = (value) => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const n = new Date(value).getTime();
  return Number.isNaN(n) ? 0 : n;
};

const presentState = (state) => (state === 'cleared' ? 'restored' : (state || 'active'));

const isAcked = (data) => Boolean(data.ackBy || data.ack_by) || data.state === 'acked' || data.state === 'closed';

const matchesStatus = (data, status) => {
  const key = String(status || 'open').trim().toLowerCase();
  const acked = isAcked(data);
  const state = data.state || 'active';
  if (key === 'recent' || key === 'recientes' || key === 'all') return true;
  if (key === 'closed' || key === 'cerradas' || key === 'acked') {
    return acked || state === 'closed' || state === 'acked';
  }
  if (key === 'active') return state === 'active' && !acked;
  if (key === 'restored' || key === 'cleared') return (state === 'restored' || state === 'cleared') && !acked;
  return !acked && (state === 'active' || state === 'restored' || state === 'cleared');
};

const toAlert = (id, data, doorNames) => {
  const type = data.type || 'alarm';
  const title = TITLES[type] || 'Alarma';
  const shown = presentState(data.state);
  const restored = shown === 'restored';
  const doorId = data.doorId || data.door_id || null;
  const where = (doorId && doorNames.get(String(doorId))) || doorId || 'Sitio';
  const acked = isAcked(data);
  return {
    id,
    kind: 'alarm',
    type,
    severity: restored || acked ? 'info' : (ERROR_TYPES.has(type) ? 'error' : 'warn'),
    title: restored ? `${title} (normalizada)` : title,
    message: data.message || (restored ? `${where}: se normalizó` : `${where}: ${title}`),
    at: new Date(toMillis(data.lastTs || data.last_ts || data.firstTs) || Date.now()).toISOString(),
    acked,
    status: acked && data.state !== 'closed' ? 'acked' : (data.state || 'active'),
    doorName: doorId ? (doorNames.get(String(doorId)) || null) : null,
    meta: {
      doorId,
      count: Number(data.count) || 1,
      state: shown
    }
  };
};

const doorNameMap = async () => {
  const snap = await db.collection('settings').doc('doorsConfig').get();
  const doors = snap.exists && Array.isArray(snap.data()?.doors) ? snap.data().doors : [];
  const map = new Map();
  doors.forEach((door) => {
    if (door && door.id) map.set(String(door.id), door.name || String(door.id));
  });
  return map;
};

const listAlarms = async ({ siteId = DEFAULT_SITE_ID, status = 'open', type = '', doorId = '', limit = 50 } = {}) => {
  const site = sanitizeSiteId(siteId);
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 50);
  const snap = await db.collection('sites').doc(site).collection('alarms').orderBy('lastTs', 'desc').limit(50).get();
  const names = await doorNameMap();
  const typeFilter = String(type || '').trim();
  const doorFilter = String(doorId || '').trim();
  let rows = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  rows.sort((a, b) => toMillis(b.lastTs || b.last_ts) - toMillis(a.lastTs || a.last_ts));
  rows = rows.filter((row) => matchesStatus(row, status));
  if (typeFilter) rows = rows.filter((row) => String(row.type || '') === typeFilter);
  if (doorFilter) rows = rows.filter((row) => String(row.doorId || row.door_id || '') === doorFilter);
  return {
    alerts: rows.slice(0, pageSize).map((row) => toAlert(row.id, row, names)),
    queriedAt: new Date().toISOString()
  };
};

const ackAlarm = async ({ siteId = DEFAULT_SITE_ID, alarmId, note, by = null, close = false } = {}) => {
  const text = String(note || '').trim();
  if (text.length < 3) throw httpError(400, 'La nota tiene que tener al menos 3 caracteres.');
  const id = String(alarmId || '').trim();
  if (!id || id.includes('/')) throw httpError(404, 'No existe esa alarma.');
  const site = sanitizeSiteId(siteId);
  const ref = db.collection('sites').doc(site).collection('alarms').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'No existe esa alarma.');
  const prev = snap.data() || {};
  const clipped = text.slice(0, 500);
  const update = {
    ackBy: by || null,
    ackNote: clipped,
    ackedAt: Date.now(),
    updatedAt: FieldValue.serverTimestamp()
  };
  if (close) update.state = 'closed';
  else if (!prev.ackBy && prev.state !== 'closed') update.state = prev.state || 'active';
  await ref.set(update, { merge: true });
  return {
    ok: true,
    before: { state: prev.state || 'active', ackBy: prev.ackBy || null },
    after: { state: update.state || prev.state || 'active', ackBy: update.ackBy, close: Boolean(close) }
  };
};

module.exports = {
  TITLES,
  listAlarms,
  ackAlarm,
  toAlert,
  matchesStatus
};
