/**
 * Estado del puente BioStar (settings/biostarBridge).
 *
 * El heartbeat solo dice "el proceso está vivo". Para saber si las huellas
 * realmente llegan se guarda además: último éxito, último error, cursor y atraso.
 * La importación exitosa de eventos también lo registra del lado servidor.
 */

const { db, FieldValue } = require('../firestore');
const { evaluateBiostarHealth } = require('./bridgeHealthEvaluate');

const SETTINGS_DOC = 'biostarBridge';

const DEFAULT_BIOSTAR_BRIDGE = {
  lastHeartbeatAt: null,
  lastError: null,
  lastErrorAt: null,
  lastSuccessAt: null,
  cursor: null,
  backlogEstimate: null
};

const serializeTs = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  return value;
};

const toMs = (value) => {
  if (value == null || value === '') return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const n = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
};

const isoOrNull = (value) => {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
};

const shortText = (value, max = 400) => {
  if (value == null || value === '') return null;
  return String(value).slice(0, max);
};

const intOrNull = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * Hora del evento según el reloj del servidor: si el puente manda `...AgoMs`
 * (milisegundos desde el hecho) se usa eso, inmune a un reloj de PC desfasado.
 */
const resolveReportedAt = (agoMs, absolute, nowMs) => {
  const ago = Number(agoMs);
  if (agoMs != null && agoMs !== '' && Number.isFinite(ago) && ago >= 0) {
    return new Date(nowMs - ago).toISOString();
  }
  return isoOrNull(absolute);
};

const sanitizeSyncSummary = (raw, nowMs) => {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {
    at: resolveReportedAt(raw.agoMs, raw.at, nowMs),
    ok: raw.ok === false ? false : (raw.ok === true ? true : null),
    error: shortText(raw.error, 300)
  };
  ['created', 'updated', 'skipped', 'accepted', 'deviceEvents', 'biostarTotal'].forEach((key) => {
    const n = intOrNull(raw[key]);
    if (n != null) out[key] = n;
  });
  if (raw.cursorDatetime) out.cursorDatetime = isoOrNull(raw.cursorDatetime);
  return out;
};

const maxIso = (...values) => {
  const ms = values.map(toMs).filter((v) => v != null);
  return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
};

const STATE_BY_HEALTH = {
  online: 'ok',
  stale: 'stale',
  degraded: 'error',
  offline: 'error'
};

const syncState = (summary) => {
  if (!summary || !summary.at) return 'unknown';
  return summary.ok === false ? 'error' : 'ok';
};

const buildBiostarStatus = (data = {}, nowMs = Date.now()) => {
  const lastSuccessAt = maxIso(data.lastSuccessAt, data.lastImportAt);
  const status = {
    lastHeartbeatAt: serializeTs(data.lastHeartbeatAt),
    lastError: data.lastError || null,
    lastErrorAt: serializeTs(data.lastErrorAt),
    lastSuccessAt,
    lastImportAt: serializeTs(data.lastImportAt),
    cursor: serializeTs(data.cursor),
    backlogEstimate: data.backlogEstimate ?? null,
    users: data.users ? { ...data.users } : null,
    events: data.events ? { ...data.events } : null,
    bridge: data.bridge ? { ...data.bridge } : null
  };
  const health = evaluateBiostarHealth(status, nowMs);
  status.health = health;
  status.state = data.lastHeartbeatAt ? (STATE_BY_HEALTH[health.status] || 'unknown') : 'unknown';
  if (status.users) status.users.state = syncState(status.users);
  if (status.events) {
    status.events.state = health.status === 'degraded' ? 'error' : syncState(status.events);
    if (!status.events.cursorDatetime && status.cursor) status.events.cursorDatetime = status.cursor;
  }
  return status;
};

const getBiostarBridgeStatus = async (nowMs = Date.now()) => {
  const snap = await db.collection('settings').doc(SETTINGS_DOC).get();
  if (!snap.exists) {
    const empty = { ...DEFAULT_BIOSTAR_BRIDGE };
    return buildBiostarStatus(empty, nowMs);
  }
  return buildBiostarStatus(snap.data() || {}, nowMs);
};

/**
 * Heartbeat del puente. Campos opcionales (puentes viejos mandan solo {}):
 * lastSuccessAt/lastSuccessAgoMs, lastError, lastErrorAt/lastErrorAgoMs,
 * cursor, backlogEstimate, users{...}, events{...}, hostname, biostarHost, version.
 */
const touchBiostarHeartbeat = async (body = {}, nowMs = Date.now()) => {
  const payload = body && typeof body === 'object' ? body : {};
  const patch = {
    lastHeartbeatAt: FieldValue.serverTimestamp(),
    lastError: shortText(payload.lastError),
    updatedAt: FieldValue.serverTimestamp()
  };
  const lastErrorAt = resolveReportedAt(payload.lastErrorAgoMs, payload.lastErrorAt, nowMs);
  patch.lastErrorAt = patch.lastError ? (lastErrorAt || new Date(nowMs).toISOString()) : null;

  const lastSuccessAt = resolveReportedAt(payload.lastSuccessAgoMs, payload.lastSuccessAt, nowMs);
  if (lastSuccessAt) patch.lastSuccessAt = lastSuccessAt;
  if (payload.cursor !== undefined) patch.cursor = isoOrNull(payload.cursor);
  if (payload.backlogEstimate !== undefined) patch.backlogEstimate = intOrNull(payload.backlogEstimate);

  const users = sanitizeSyncSummary(payload.users, nowMs);
  if (users) patch.users = users;
  const events = sanitizeSyncSummary(payload.events, nowMs);
  if (events) patch.events = events;

  const bridge = {};
  if (payload.hostname) bridge.hostname = shortText(payload.hostname, 80);
  if (payload.biostarHost) bridge.biostarHost = shortText(payload.biostarHost, 120);
  if (payload.version) bridge.version = shortText(payload.version, 40);
  if (Object.keys(bridge).length) patch.bridge = bridge;

  await db.collection('settings').doc(SETTINGS_DOC).set(patch, { merge: true });
  return getBiostarBridgeStatus(nowMs);
};

/**
 * Registro del lado servidor de una importación de eventos que terminó bien.
 * No depende de que el puente mande heartbeat.
 */
const recordBiostarEventsImport = async (result = {}) => {
  const patch = {
    lastImportAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  if (result.cursorDatetime) patch.cursor = isoOrNull(result.cursorDatetime);
  await db.collection('settings').doc(SETTINGS_DOC).set(patch, { merge: true });
};

module.exports = {
  SETTINGS_DOC,
  buildBiostarStatus,
  getBiostarBridgeStatus,
  touchBiostarHeartbeat,
  recordBiostarEventsImport,
  resolveReportedAt
};
