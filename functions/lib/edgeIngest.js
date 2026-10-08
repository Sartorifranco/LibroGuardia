/**
 * Ingesta y operación del edge en la nube (Etapa 2, docs/ETAPA2-DISENO.md §3, §4, §7).
 *
 * - Lotes de eventos del hub → UN doc de journal con id determinístico (idempotente) +
 *   proyecciones: `entries` (solo movimientos autorizados, campos compat del frontend),
 *   `sites/{s}/alarms/{id}` y cursor `sites/{s}/status/hub`. Mails D20 solo para alarmas críticas.
 *   Presupuesto por lote: 1 lectura + (1 + #entries + #alarmas + 1) escrituras, en un batch.
 * - Heartbeat de equipos con escritura condicionada (cambio o > 5 min).
 * - Comandos nube → hub (`sites/{s}/commands/{id}`, TTL 45 s) y su resultado.
 * - `live/summary` (lo escribe el hub; la vista remota lo lee con caché).
 * - Adaptador del compilador por sitio (T2, `lib/siteCompiler`), con carga perezosa.
 */

const crypto = require('crypto');
const { db, FieldValue, Timestamp } = require('../firestore');
const { getArgentinaDateParts } = require('./normalize');
const { DEVICES_COLLECTION, httpError, toMillis } = require('./devices');

const MAX_EVENTS_PER_BATCH = 200;
const MAX_EVENT_PAYLOAD_BYTES = 2048;
const HEARTBEAT_MIN_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const COMMAND_TTL_MS = 45 * 1000;
const MAX_LIVE_SUMMARY_BYTES = 64 * 1024;
const MAX_CHUNK_NAMES = 80;

/** Tipos de evento que proyectan una alarma (§5). */
const ALARM_TYPES = new Set([
  'door_forced',
  'held_open',
  'duress',
  'interlock_violation',
  'device_offline',
  'lock_fault',
  'emergency'
]);

/**
 * Alarmas críticas → mail (D20: solo email). Valor = tipo de evento de lib/notifications.
 * door_forced / emergency / interlock_violation todavía no tienen plantilla en
 * notifications (EVENT_TYPES): quedan en `null` hasta sumar 'edge_alarm' allí.
 */
const CRITICAL_ALARM_NOTIFY = {
  duress: 'duress_access',
  device_offline: 'bridge_offline',
  door_forced: null,
  emergency: null,
  interlock_violation: null
};

const COMMAND_RESULT_STATUSES = ['done', 'failed'];

const siteRef = (siteId) => db.collection('sites').doc(String(siteId));

const safeIdPart = (value) => String(value ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);

const isPositiveInt = (n) => Number.isInteger(n) && n >= 0;

const ymdFor = (ms) => getArgentinaDateParts(new Date(ms)).dateString.replace(/-/g, '');

const journalDocId = ({ hubId, hubSeqFrom, firstTs }) => `${ymdFor(firstTs)}_${safeIdPart(hubId)}_${hubSeqFrom}`;

const capPayload = (payload) => {
  if (payload == null || typeof payload !== 'object') return null;
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) <= MAX_EVENT_PAYLOAD_BYTES) return JSON.parse(json);
  return { truncated: true };
};

/** Normaliza un evento del hub (forma de scripts/edge/lib/db/journal.js `rowToEvent`). */
const normalizeEvent = (raw, index) => {
  if (!raw || typeof raw !== 'object') throw httpError(400, `Evento ${index} inválido`);
  const id = String(raw.id || '').trim();
  const ts = Number(raw.ts);
  const type = String(raw.type || '').trim();
  if (!id || id.length > 200) throw httpError(400, `Evento ${index}: falta id`);
  if (!Number.isFinite(ts) || ts <= 0) throw httpError(400, `Evento ${index}: ts inválido`);
  if (!type) throw httpError(400, `Evento ${index}: falta type`);
  const str = (v, max = 120) => (v == null || v === '' ? null : String(v).slice(0, max));
  return {
    id,
    seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null,
    hubSeq: Number.isFinite(Number(raw.hubSeq)) ? Number(raw.hubSeq) : null,
    ts,
    clockQ: str(raw.clockQ, 20),
    deviceId: str(raw.deviceId),
    doorId: str(raw.doorId),
    side: raw.side === 'out' ? 'out' : (raw.side === 'in' ? 'in' : null),
    type,
    credType: str(raw.credType, 20),
    credHash: str(raw.credHash, 128),
    cardholderId: str(raw.cardholderId),
    decision: str(raw.decision, 20),
    reason: str(raw.reason, 80),
    payload: capPayload(raw.payload)
  };
};

const isGrantedMovement = (ev) => ev.decision === 'grant' && !ALARM_TYPES.has(ev.type);

const maskIdNumber = (ev) => {
  const p = ev.payload || {};
  if (p.idNumber) return String(p.idNumber).slice(0, 20);
  if (p.idNumberMasked) return String(p.idNumberMasked).slice(0, 20);
  return ev.credHash ? '***' : '';
};

/** Doc `entries` compatible con el libro actual (ver accessControl.js writeAccessEntry). */
const buildEntryDoc = (ev, { siteId, hubId }) => {
  const p = ev.payload || {};
  const tipoMovimiento = ev.side === 'out' ? 'egreso' : 'ingreso';
  const name = String(p.name || p.cardholderName || '').slice(0, 160);
  const idNumber = maskIdNumber(ev);
  const at = new Date(ev.ts);
  return {
    type: 'personal',
    tipoMovimiento,
    movementType: tipoMovimiento,
    name,
    nameSnapshot: name,
    idNumber,
    dniSnapshot: idNumber || null,
    personId: ev.cardholderId || null,
    doorId: ev.doorId || null,
    doorName: p.doorName ? String(p.doorName).slice(0, 120) : null,
    timestamp: Timestamp.fromDate(at),
    eventTime: getArgentinaDateParts(at).timeString,
    accessAuthorized: true,
    authorized: true,
    accessReason: ev.reason || p.matchedSource || 'autorizado',
    authorizationType: p.matchedSource || null,
    denialReason: null,
    entrySource: 'edge',
    channel: 'edge',
    relayConfirmed: p.relayConfirmed ?? null,
    doorOpened: p.doorOpened ?? null,
    credType: ev.credType || null,
    clockQ: ev.clockQ || null,
    mode: p.mode || 'scan',
    registeredBy: ev.deviceId || hubId,
    guardId: p.actor || null,
    notes: null,
    edge: { siteId, hubId, deviceId: ev.deviceId || null, eventId: ev.id, seq: ev.seq, hubSeq: ev.hubSeq },
    createdAt: FieldValue.serverTimestamp()
  };
};

const alarmIdFor = (ev, hubId) => safeIdPart(ev.payload?.alarmId || `${hubId}_${ev.id}`);

const buildAlarmDoc = (ev, { siteId, hubId }) => {
  const p = ev.payload || {};
  const state = ['active', 'cleared', 'acked'].includes(p.state) ? p.state : 'active';
  return {
    siteId,
    type: ev.type,
    doorId: ev.doorId || null,
    deviceId: p.deviceId || ev.deviceId || null,
    hubId,
    state,
    critical: Object.prototype.hasOwnProperty.call(CRITICAL_ALARM_NOTIFY, ev.type),
    firstTs: Number(p.firstTs) || ev.ts,
    lastTs: Number(p.lastTs) || ev.ts,
    count: Number.isFinite(Number(p.count)) ? Number(p.count) : 1,
    eventId: ev.id,
    cardholderId: ev.cardholderId || null,
    message: p.message ? String(p.message).slice(0, 300) : null,
    updatedAt: FieldValue.serverTimestamp()
  };
};

const notifyCriticalAlarm = (notifySafe, ev, alarm) => {
  const eventType = CRITICAL_ALARM_NOTIFY[ev.type];
  if (!eventType || alarm.state !== 'active' || typeof notifySafe !== 'function') return false;
  const p = ev.payload || {};
  const at = new Date(ev.ts).toISOString();
  if (eventType === 'duress_access') {
    notifySafe(eventType, { name: p.name || ev.cardholderId || null, doorId: ev.doorId, at, entryId: ev.id });
  } else if (eventType === 'bridge_offline') {
    notifySafe(eventType, { name: p.name || alarm.deviceId, id: alarm.deviceId, kind: 'edge', lastAt: at });
  }
  return true;
};

/**
 * Ingesta de un lote del hub.
 * @returns {Promise<{ackHubSeq:number, duplicate:boolean, journalId:string, entries:number, alarms:number, notified:number}>}
 */
const ingestEventBatch = async ({ siteId, hubId, body = {}, notifySafe = null, now = Date.now() }) => {
  if (body.hubId != null && String(body.hubId) !== String(hubId)) {
    throw httpError(403, 'hubId no coincide con el equipo autenticado', 'HUB_MISMATCH');
  }
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events || !events.length) throw httpError(400, 'Falta events');
  if (events.length > MAX_EVENTS_PER_BATCH) throw httpError(400, `Máximo ${MAX_EVENTS_PER_BATCH} eventos por lote`);
  const hubSeqFrom = Number(body.hubSeqFrom);
  const hubSeqTo = Number(body.hubSeqTo);
  if (!isPositiveInt(hubSeqFrom) || !isPositiveInt(hubSeqTo) || hubSeqTo < hubSeqFrom) {
    throw httpError(400, 'hubSeqFrom/hubSeqTo inválidos');
  }
  const normalized = events.map(normalizeEvent);
  const journalId = journalDocId({ hubId, hubSeqFrom, firstTs: normalized[0].ts });
  const site = siteRef(siteId);
  const journalRef = site.collection('journal').doc(journalId);

  // Única lectura del lote: ¿ya se procesó? (reintento del hub tras perder el ack)
  const existing = await journalRef.get();
  if (existing.exists) {
    const data = existing.data() || {};
    return {
      ackHubSeq: Number(data.hubSeqTo),
      duplicate: true,
      journalId,
      entries: 0,
      alarms: 0,
      notified: 0
    };
  }

  const batch = db.batch();
  batch.set(journalRef, {
    siteId,
    hubId,
    hubSeqFrom,
    hubSeqTo,
    count: normalized.length,
    firstTs: normalized[0].ts,
    lastTs: normalized[normalized.length - 1].ts,
    events: normalized,
    receivedAt: now,
    createdAt: FieldValue.serverTimestamp()
  });

  let entries = 0;
  const alarms = [];
  normalized.forEach((ev) => {
    if (ALARM_TYPES.has(ev.type)) {
      const alarm = buildAlarmDoc(ev, { siteId, hubId });
      batch.set(site.collection('alarms').doc(alarmIdFor(ev, hubId)), alarm, { merge: true });
      alarms.push({ ev, alarm });
      return;
    }
    if (isGrantedMovement(ev)) {
      // Id determinístico: aun con dos lotes concurrentes iguales no se duplica el libro.
      const entryId = `edge_${safeIdPart(hubId)}_${safeIdPart(ev.id)}`;
      batch.set(db.collection('entries').doc(entryId), buildEntryDoc(ev, { siteId, hubId }));
      entries += 1;
    }
  });

  batch.set(site.collection('status').doc('hub'), {
    hubId,
    ackHubSeq: hubSeqTo,
    lastSeenAt: now,
    lastBatchAt: now,
    lastJournalId: journalId
  }, { merge: true });

  await batch.commit();

  let notified = 0;
  alarms.forEach(({ ev, alarm }) => {
    if (notifyCriticalAlarm(notifySafe, ev, alarm)) notified += 1;
  });

  return { ackHubSeq: hubSeqTo, duplicate: false, journalId, entries, alarms: alarms.length, notified };
};

const sanitizeLanUrl = (value) => {
  if (value == null || value === '') return null;
  const url = String(value).trim();
  if (url.length > 200 || !/^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[^\s]*)?$/.test(url)) {
    throw httpError(400, 'lanUrl inválida');
  }
  return url;
};

const stableJson = (value) => {
  if (value == null) return 'null';
  try { return JSON.stringify(value); } catch { return String(value); }
};

/**
 * Heartbeat: 1 lectura del equipo; escribe solo si cambió algo o pasaron > 5 min
 * desde la última escritura. El hub además publica `sites/{s}.lanUrl` si cambió.
 */
const recordHeartbeat = async ({ deviceId, siteId, deviceKind, body = {}, now = Date.now() }) => {
  const ref = db.collection(DEVICES_COLLECTION).doc(String(deviceId));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(401, 'Equipo no encontrado', 'INVALID_DEVICE');
  const d = snap.data() || {};
  if (d.status !== 'active') throw httpError(401, 'Equipo revocado o reemplazado', 'DEVICE_REVOKED');

  const configVersionApplied = body.configVersionApplied == null ? null : Number(body.configVersionApplied);
  const checks = body.checks && typeof body.checks === 'object' ? JSON.parse(JSON.stringify(body.checks)) : null;
  if (checks && Buffer.byteLength(JSON.stringify(checks)) > 8192) throw httpError(400, 'checks demasiado grande');
  const lanUrl = deviceKind === 'hub' ? sanitizeLanUrl(body.lanUrl) : null;

  const changed = (d.configVersionApplied ?? null) !== configVersionApplied
    || stableJson(d.checks ?? null) !== stableJson(checks)
    || (deviceKind === 'hub' && (d.lanUrl || null) !== lanUrl);
  const lastWrite = toMillis(d.lastSeenAt) || 0;
  const stale = now - lastWrite > HEARTBEAT_MIN_WRITE_INTERVAL_MS;

  let wrote = false;
  let siteWrote = false;
  if (changed || stale) {
    const update = { lastSeenAt: now, configVersionApplied, checks };
    if (deviceKind === 'hub') update.lanUrl = lanUrl;
    await ref.set(update, { merge: true });
    wrote = true;
  }
  if (deviceKind === 'hub' && lanUrl && (d.lanUrl || null) !== lanUrl) {
    await siteRef(siteId).set({ lanUrl, lanUrlUpdatedAt: now }, { merge: true });
    siteWrote = true;
  }
  return {
    ok: true,
    wrote,
    siteWrote,
    nextHeartbeatSec: HEARTBEAT_MIN_WRITE_INTERVAL_MS / 1000
  };
};

// ───────────────────────────── Comandos ─────────────────────────────

const commandRef = (siteId, id) => {
  const cid = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(cid)) throw httpError(404, 'Comando no encontrado');
  return siteRef(siteId).collection('commands').doc(cid);
};

const effectiveCommand = (id, data = {}, now = Date.now()) => {
  const expired = data.status === 'pending' && Number(data.expiresAt) < now;
  return {
    id,
    doorId: data.doorId || null,
    doorName: data.doorName || null,
    action: data.action || 'open',
    status: expired ? 'expired' : (data.status || 'pending'),
    force: Boolean(data.force),
    reason: data.reason || null,
    requestedBy: data.requestedBy || null,
    createdAt: data.createdAt || null,
    expiresAt: data.expiresAt || null,
    completedAt: data.completedAt || null,
    result: data.result || null
  };
};

/** Encola una apertura remota (1 escritura). La recoge el listener del hub. */
const createOpenCommand = async ({ siteId, door, requestedBy, reason, force = false, forceReason = null, now = Date.now() }) => {
  const id = `cmd_${now.toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  const data = {
    siteId,
    doorId: door.id,
    doorName: door.name || null,
    controllerId: door.controllerId,
    action: 'open',
    requestedBy,
    reason: String(reason || 'apertura_remota').slice(0, 500),
    force: Boolean(force),
    forceReason: force ? String(forceReason || '').slice(0, 500) : null,
    status: 'pending',
    createdAt: now,
    expiresAt: now + COMMAND_TTL_MS,
    result: null
  };
  await commandRef(siteId, id).set(data);
  return effectiveCommand(id, data, now);
};

const getCommand = async ({ siteId, id, now = Date.now() }) => {
  const snap = await commandRef(siteId, id).get();
  if (!snap.exists) throw httpError(404, 'Comando no encontrado');
  return effectiveCommand(snap.id || id, snap.data() || {}, now);
};

/** Resultado real del hub (idempotente: un comando terminado no se pisa). */
const recordCommandResult = async ({ siteId, id, hubId, body = {}, now = Date.now() }) => {
  const status = String(body.status || '');
  if (!COMMAND_RESULT_STATUSES.includes(status)) throw httpError(400, "status debe ser 'done' o 'failed'");
  const ref = commandRef(siteId, id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, 'Comando no encontrado');
    const data = snap.data() || {};
    if (COMMAND_RESULT_STATUSES.includes(data.status)) {
      return { ...effectiveCommand(id, data, now), duplicate: true };
    }
    const result = {
      relayConfirmed: body.relayConfirmed === true,
      doorOpened: body.doorOpened == null ? null : body.doorOpened === true,
      reason: body.reason ? String(body.reason).slice(0, 300) : null
    };
    const update = { status, result, completedAt: now, completedBy: hubId, lateResult: Number(data.expiresAt) < now };
    tx.set(ref, update, { merge: true });
    return { ...effectiveCommand(id, { ...data, ...update }, now), duplicate: false };
  });
};

// ───────────────────────────── Live ─────────────────────────────

const liveRef = (siteId) => siteRef(siteId).collection('live').doc('summary');

const writeLiveSummary = async ({ siteId, hubId, body = {}, now = Date.now() }) => {
  const summary = body && typeof body === 'object' ? (body.summary ?? body) : {};
  const json = JSON.stringify(summary);
  if (Buffer.byteLength(json) > MAX_LIVE_SUMMARY_BYTES) throw httpError(413, 'live/summary demasiado grande');
  await liveRef(siteId).set({ summary: JSON.parse(json), hubId, updatedAt: now });
  return { ok: true, updatedAt: now };
};

const readLiveSummary = async (siteId) => {
  const snap = await liveRef(siteId).get();
  if (!snap.exists) return { siteId, summary: null, updatedAt: null };
  const data = snap.data() || {};
  return { siteId, summary: data.summary ?? null, updatedAt: data.updatedAt ?? null, hubId: data.hubId || null };
};

// ───────────────────── Adaptador del compilador (T2) ─────────────────────

let compilerOverride;

/** Solo tests: inyecta un compilador falso (o `null` = no disponible). `undefined` restaura. */
const setSiteCompilerForTests = (impl) => { compilerOverride = impl; };

/**
 * `functions/lib/siteCompiler` (T2) exporta getHead(siteId), getChunks(siteId, names),
 * compileSite, getSigningPublicKey(). Si todavía no está → null (las rutas responden 503).
 */
const getSiteCompiler = () => {
  if (compilerOverride !== undefined) return compilerOverride;
  try {
    // eslint-disable-next-line global-require
    return require('./siteCompiler');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('siteCompiler')) return null;
    throw err;
  }
};

const requireSiteCompiler = () => {
  const compiler = getSiteCompiler();
  if (!compiler || typeof compiler.getHead !== 'function') {
    throw httpError(503, 'compilador no disponible', 'COMPILER_UNAVAILABLE');
  }
  return compiler;
};

const readHead = async (siteId) => {
  const compiler = requireSiteCompiler();
  const head = await compiler.getHead(siteId);
  let publicKey = null;
  if (typeof compiler.getSigningPublicKey === 'function') {
    publicKey = await compiler.getSigningPublicKey();
  }
  const keyId = (publicKey && typeof publicKey === 'object' ? publicKey.keyId : null) || head?.keyId || null;
  const pem = publicKey && typeof publicKey === 'object' ? (publicKey.publicKey || publicKey.pem || null)
    : (typeof publicKey === 'string' ? publicKey : null);
  return { siteId, head: head || null, keyId, publicKey: pem };
};

const parseChunkNames = (raw) => {
  const list = (Array.isArray(raw) ? raw.join(',') : String(raw || ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) throw httpError(400, 'Falta names');
  if (unique.length > MAX_CHUNK_NAMES) throw httpError(400, `Máximo ${MAX_CHUNK_NAMES} chunks por pedido`);
  if (unique.some((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n))) throw httpError(400, 'Nombre de chunk inválido');
  return unique;
};

const readChunks = async (siteId, rawNames) => {
  const names = parseChunkNames(rawNames);
  const compiler = requireSiteCompiler();
  if (typeof compiler.getChunks !== 'function') throw httpError(503, 'compilador no disponible', 'COMPILER_UNAVAILABLE');
  const chunks = await compiler.getChunks(siteId, names);
  return { siteId, chunks: chunks || {} };
};

module.exports = {
  MAX_EVENTS_PER_BATCH,
  HEARTBEAT_MIN_WRITE_INTERVAL_MS,
  COMMAND_TTL_MS,
  ALARM_TYPES,
  CRITICAL_ALARM_NOTIFY,
  journalDocId,
  normalizeEvent,
  isGrantedMovement,
  buildEntryDoc,
  buildAlarmDoc,
  ingestEventBatch,
  recordHeartbeat,
  createOpenCommand,
  getCommand,
  recordCommandResult,
  effectiveCommand,
  writeLiveSummary,
  readLiveSummary,
  setSiteCompilerForTests,
  getSiteCompiler,
  readHead,
  readChunks,
  parseChunkNames
};
