/**
 * Ingesta y operación del edge en la nube (Etapa 2, docs/ETAPA2-DISENO.md §3, §4, §7).
 *
 * - Lotes de eventos del hub → UN doc de journal con id determinístico (idempotente) +
 *   proyecciones: `entries` (solo movimientos autorizados que cuentan como paso, campos compat
 *   del frontend). `reason: 'lectura_repetida'` queda en el journal y NO crea otro doc
 *   en `entries`: es el mismo paso (otra credencial o un reintento dentro de
 *   repeatWindowSec). El feed de planta lo muestra desde el journal del hub; los
 *   conteos y reportes que leen `entries` no lo suman.
 *   `sites/{s}/alarms/{id}` y cursor `sites/{s}/status/hub`. Mails D20 solo para alarmas críticas.
 *   Presupuesto por lote: 1 lectura + (1 + #entries + #alarmas + 1) escrituras, en un batch.
 * - Heartbeat de equipos con escritura condicionada (cambio o > 5 min).
 * - Comandos nube → hub (`sites/{s}/commands/{id}`, TTL 45 s) y su resultado. Señal barata:
 *   `sites/{s}/status/commands {pending, updatedAt}` (FieldValue.increment: +1 al crear, −1 al
 *   terminar/vencer; se acota a ≥ 0 al leer) → `pendingCommands` en GET /head; el hub solo
 *   consulta GET /commands?status=pending cuando es > 0.
 * - `live/summary` (lo escribe el hub; la vista remota lo lee con caché).
 * - Adaptador del compilador por sitio (T2, `lib/siteCompiler`), con carga perezosa.
 */

const crypto = require('crypto');
const { db, FieldValue, Timestamp } = require('../firestore');
const { getArgentinaDateParts } = require('./normalize');
const { DEVICES_COLLECTION, httpError, toMillis, appendDeviceLog } = require('./devices');
const { problemSignature, problemLabels, CLOCK_SKEW_MS } = require('./deviceHealth');

const MAX_EVENTS_PER_BATCH = 200;
const MAX_EVENT_PAYLOAD_BYTES = 2048;
const HEARTBEAT_MIN_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const COMMAND_TTL_MS = 45 * 1000;
const MAX_LIVE_SUMMARY_BYTES = 64 * 1024;
const MAX_CHUNK_NAMES = 80;

/**
 * Tipos de alarma (§5). Mantener en sincronía con scripts/edge/hub/liveState.js ALARM_TYPES.
 * Contrato del controlador (scripts/edge/controller/controller.js onDoorEffect): las alarmas
 * llegan como `type:'alarm'`, `reason:<tipo>`, `payload.state:'raised'|'cleared'`. También se
 * aceptan eventos cuyo `type` ya es el tipo de alarma (hub, BioStar).
 */
const ALARM_TYPES = new Set([
  'door_forced',
  'held_open',
  'duress',
  'interlock_violation',
  'device_offline',
  'lock_fault',
  'emergency',
  'ingreso_emergencia',
  'tamper',
  'hub_offline',
  'config_stale',
  'credential_key_missing'
]);

/** Tipo de alarma del evento (o null si no es alarma). */
const alarmTypeOf = (ev) => {
  if (ev.type === 'alarm') return ev.reason || 'alarm';
  return ALARM_TYPES.has(ev.type) ? ev.type : null;
};

/**
 * Alarmas críticas → mail (D20: solo email). Valor = tipo de evento de lib/notifications.
 * door_forced / emergency / interlock_violation todavía no tienen plantilla en
 * notifications (EVENT_TYPES): quedan en `null` hasta sumar 'edge_alarm' allí.
 */
const CRITICAL_ALARM_NOTIFY = {
  duress: 'duress_access',
  device_offline: 'bridge_offline',
  door_forced: 'edge_alarm',
  emergency: 'edge_alarm',
  interlock_violation: 'edge_alarm'
};

/** Estados finales que puede reportar el hub (scripts/edge/hub/commands.js). */
const COMMAND_RESULT_STATUSES = ['done', 'failed', 'expired', 'rejected'];
const MAX_PENDING_COMMANDS_LISTED = 50;

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

/** Concedido que cuenta como paso. La lectura repetida se archiva en el journal, sin fila en entries. */
const isGrantedMovement = (ev) => ev.decision === 'grant' && ev.reason !== 'lectura_repetida' && !alarmTypeOf(ev);

/**
 * 1b: la visita pasa a "Ingresó HH:MM" cuando llega el paso de su pase. El hub agrega
 * `payload.visitaId` (eventUploader); si falta, se busca por id de pase (= id del doc o passCode).
 * Presupuesto: 1 lectura + ≤1 escritura por visita del lote. Sin markDirty: el borde ya aplicó
 * el uso del pase y `ingreso_registrado`/`egreso_registrado` siguen generando pase.
 * Nunca hace fallar la ingesta (el lote ya está confirmado).
 */
const VISITAS_COLLECTION = 'visitas';
const VISITA_CLOSED_STATES = new Set(['cancelada', 'rechazada', 'revocada']);

const visitaMovementsOf = (events) => {
  const byKey = new Map();
  events.forEach((ev) => {
    if (!isGrantedMovement(ev)) return;
    const p = ev.payload || {};
    const visitaId = p.visitaId ? String(p.visitaId) : null;
    const passId = p.passId ? String(p.passId) : null;
    if (!visitaId && !passId) return;
    const key = visitaId ? `v:${visitaId}` : `p:${passId}`;
    const cur = byKey.get(key) || { visitaId, passId, firstInTs: null, firstInDoorId: null, firstInDoorName: null, lastTs: 0, lastSide: null };
    if (ev.side !== 'out' && cur.firstInTs == null) {
      cur.firstInTs = ev.ts;
      cur.firstInDoorId = ev.doorId || null;
      cur.firstInDoorName = p.doorName ? String(p.doorName).slice(0, 120) : null;
    }
    if (ev.ts >= cur.lastTs) {
      cur.lastTs = ev.ts;
      cur.lastSide = ev.side === 'out' ? 'out' : 'in';
    }
    byKey.set(key, cur);
  });
  return [...byKey.values()];
};

const findVisitaRef = async (mv) => {
  const col = db.collection(VISITAS_COLLECTION);
  if (mv.visitaId) {
    const snap = await col.doc(mv.visitaId).get();
    return snap.exists ? snap : null;
  }
  const byId = await col.doc(mv.passId).get();
  if (byId.exists) return byId;
  const q = await col.where('passCode', '==', mv.passId).limit(1).get();
  return q.empty ? null : q.docs[0];
};

const markVisitasFromEvents = async (events, { log = console } = {}) => {
  let marked = 0;
  for (const mv of visitaMovementsOf(events)) {
    try {
      const snap = await findVisitaRef(mv);
      if (!snap) continue;
      const data = snap.data() || {};
      if (VISITA_CLOSED_STATES.has(data.estado)) continue;
      const patch = { updatedAt: FieldValue.serverTimestamp() };
      if (mv.firstInTs != null && !data.ingresoAt) {
        patch.ingresoAt = Timestamp.fromDate(new Date(mv.firstInTs));
        patch.ingresoDoorId = mv.firstInDoorId;
        patch.ingresoDoorName = mv.firstInDoorName;
      }
      if (mv.lastSide === 'out') {
        patch.estado = 'egreso_registrado';
        patch.egresoAt = Timestamp.fromDate(new Date(mv.lastTs));
      } else {
        patch.estado = 'ingreso_registrado';
      }
      if (patch.estado === data.estado && !patch.ingresoAt && !patch.egresoAt) continue;
      await db.collection(VISITAS_COLLECTION).doc(snap.id).set(patch, { merge: true });
      marked += 1;
    } catch (err) {
      if (log && log.warn) log.warn(`[edge] no se pudo marcar la visita ${mv.visitaId || mv.passId}: ${err.message}`);
    }
  }
  return marked;
};

const maskIdNumber = (ev) => {
  const p = ev.payload || {};
  if (p.idNumber) return String(p.idNumber).slice(0, 20);
  if (p.idNumberMasked) return String(p.idNumberMasked).slice(0, 20);
  return ev.credHash ? '***' : '';
};

/** Fuentes de empleados (no avisan al guardia). Igual que scripts/edge/hub/lanApi/visitors.js. */
const EMPLOYEE_SOURCES = new Set(['accessAll', 'group', 'direct']);

/** 1b: datos de visita/externo para el cartel del guardia en modo nube (liveAlerts). */
const visitorFieldsOf = (ev) => {
  const p = ev.payload || {};
  const source = p.matched && p.matched.source;
  let visitorKind = null;
  if (p.passId) visitorKind = 'visita';
  else if (source && !EMPLOYEE_SOURCES.has(source)) visitorKind = 'externo';
  if (!visitorKind) return {};
  const v = p.visitor || {};
  const str = (x, n) => (x ? String(x).slice(0, n) : null);
  return {
    visitorKind,
    passId: str(p.passId, 120),
    visitaId: str(p.visitaId, 120),
    hostName: str(v.hostName, 120),
    hostCompany: str(v.hostCompany, 120),
    destination: str(v.destination, 120)
  };
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
    ...visitorFieldsOf(ev),
    createdAt: FieldValue.serverTimestamp()
  };
};

/**
 * Un doc por (tipo, puerta|equipo): el 'cleared' del controlador cierra el mismo doc que abrió
 * el 'raised'. `payload.alarmId` explícito manda.
 */
const alarmIdFor = (ev, hubId) => safeIdPart(
  ev.payload?.alarmId || `${hubId}_${alarmTypeOf(ev)}_${ev.doorId || ev.deviceId || 'sitio'}`
);

const ALARM_STATE = { raised: 'active', active: 'active', cleared: 'cleared', restored: 'cleared', acked: 'acked' };

const buildAlarmDoc = (ev, { siteId, hubId }) => {
  const p = ev.payload || {};
  const state = ALARM_STATE[p.state] || 'active';
  const type = alarmTypeOf(ev);
  return {
    siteId,
    type,
    doorId: ev.doorId || null,
    deviceId: p.deviceId || ev.deviceId || null,
    hubId,
    state,
    critical: Object.prototype.hasOwnProperty.call(CRITICAL_ALARM_NOTIFY, type),
    firstTs: Number(p.firstTs) || ev.ts,
    lastTs: Number(p.lastTs) || ev.ts,
    count: Number.isFinite(Number(p.count)) ? Number(p.count) : 1,
    eventId: ev.id,
    cardholderId: ev.cardholderId || null,
    message: p.message ? String(p.message).slice(0, 300) : (p.detail ? String(p.detail).slice(0, 300) : null),
    updatedAt: FieldValue.serverTimestamp()
  };
};

const notifyCriticalAlarm = (notifySafe, ev, alarm) => {
  const eventType = CRITICAL_ALARM_NOTIFY[alarm.type];
  if (!eventType || alarm.state !== 'active' || typeof notifySafe !== 'function') return false;
  const p = ev.payload || {};
  const at = new Date(ev.ts).toISOString();
  if (eventType === 'duress_access') {
    notifySafe(eventType, { name: p.name || ev.cardholderId || null, doorId: ev.doorId, at, entryId: ev.id });
  } else if (eventType === 'bridge_offline') {
    notifySafe(eventType, { name: p.name || alarm.deviceId, id: alarm.deviceId, kind: 'edge', lastAt: at });
  } else if (eventType === 'edge_alarm') {
    notifySafe(eventType, {
      alarmType: alarm.type,
      doorId: ev.doorId || null,
      doorName: p.doorName || null,
      deviceId: alarm.deviceId || ev.deviceId || null,
      at,
      message: p.message || null
    });
  }
  return true;
};

/**
 * Ingesta de un lote del hub.
 * @returns {Promise<{ackHubSeq:number, duplicate:boolean, journalId:string, entries:number, alarms:number, notified:number, visitas:number}>}
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
    if (alarmTypeOf(ev)) {
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

  const visitas = await markVisitasFromEvents(normalized);

  return { ackHubSeq: hubSeqTo, duplicate: false, journalId, entries, alarms: alarms.length, notified, visitas };
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

const MAX_REPORTED_CONTROLLERS = 64;
/**
 * Aunque no cambie nada, el estado de cada controlador se refresca cada 10 min (lastSeenAt).
 * Tiene que ser menor que OFFLINE_AFTER_MS (15 min) o el controlador se ve "Sin conexión".
 */
const CONTROLLER_STATUS_REFRESH_MS = 10 * 60 * 1000;

/** `controllers` del heartbeat del hub → { id: {configVersionApplied, online, lastSeenAt, lastError} }. */
const normalizeReportedControllers = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  Object.entries(raw).slice(0, MAX_REPORTED_CONTROLLERS).forEach(([id, st]) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !st || typeof st !== 'object') return;
    const v = st.configVersionApplied == null ? null : Number(st.configVersionApplied);
    const seen = st.lastSeenAt == null ? null : Number(st.lastSeenAt);
    out[id] = {
      configVersionApplied: Number.isFinite(v) ? v : null,
      online: st.online === true,
      lastSeenAt: Number.isFinite(seen) ? seen : null,
      lastError: st.lastError ? String(st.lastError).slice(0, 120) : null
    };
  });
  return out;
};

const controllerStatusChanged = (prev, cur, now) => !prev
  || (prev.configVersionApplied ?? null) !== cur.configVersionApplied
  || Boolean(prev.online) !== cur.online
  || (prev.lastError ?? null) !== cur.lastError
  || now - (Number(prev.writtenAt) || 0) > CONTROLLER_STATUS_REFRESH_MS;

/**
 * Estado de controladores informado por el hub → `devices/{ctl}` SOLO de los que cambiaron
 * (configVersionApplied / online / lastError, o refresco cada 10 min). Lo último informado
 * queda en el doc del hub (`controllersReported`, ya leído) para comparar sin leer cada
 * controlador. Por cada cambio: 1 lectura (validar sitio/tipo/estado) + 1 escritura.
 */
const applyReportedControllers = async ({ hubData, hubId, siteId, reported, now }) => {
  const prevMap = hubData.controllersReported && typeof hubData.controllersReported === 'object'
    ? hubData.controllersReported : {};
  const nextMap = {};
  let written = 0;
  let ignored = 0;
  for (const [id, cur] of Object.entries(reported)) {
    const prev = prevMap[id];
    if (!controllerStatusChanged(prev, cur, now)) {
      nextMap[id] = prev;
      continue;
    }
    const ref = db.collection(DEVICES_COLLECTION).doc(id);
    // eslint-disable-next-line no-await-in-loop
    const snap = await ref.get();
    const c = snap.exists ? snap.data() || {} : null;
    if (!c || c.kind !== 'controller' || (c.siteId || 'principal') !== siteId || c.status !== 'active') {
      ignored += 1;
      continue;
    }
    // En línea según el hub: se usa la hora del servidor (lo informado puede tener minutos).
    // eslint-disable-next-line no-await-in-loop
    await ref.set({
      configVersionApplied: cur.configVersionApplied,
      online: cur.online,
      lastSeenAt: cur.online ? now : cur.lastSeenAt,
      lastError: cur.lastError,
      reportedBy: hubId,
      statusUpdatedAt: now
    }, { merge: true });
    const becameDown = cur.online === false && c.online !== false;
    const cameBack = cur.online === true && c.online === false;
    const errorChanged = (c.lastError ?? null) !== (cur.lastError ?? null) && Boolean(c.lastError || cur.lastError);
    if (becameDown || cameBack || errorChanged) {
      const labels = problemLabels(c.checks, now, cur.lastError);
      const message = !cur.online
        ? 'Sin conexión'
        : (labels.length ? `Con problemas: ${labels.join('. ')}` : 'Volvió a estar en línea');
      appendDeviceLog(id, {
        action: 'device.checks',
        message,
        at: now,
        detail: cur.lastError || null
      }).catch((err) => console.error('[edge] bitácora controlador', err.message));
    }
    nextMap[id] = { ...cur, writtenAt: now };
    written += 1;
  }
  const mapChanged = stableJson(prevMap) !== stableJson(nextMap);
  return { nextMap, written, ignored, mapChanged };
};

/**
 * Heartbeat: 1 lectura del equipo; escribe solo si cambió algo o pasaron > 5 min
 * desde la última escritura. El hub además publica `sites/{s}.lanUrl` si cambió y el
 * estado de sus controladores (`controllers`, ver applyReportedControllers).
 */
const recordHeartbeat = async ({ deviceId, siteId, deviceKind, body = {}, now = Date.now() }) => {
  const ref = db.collection(DEVICES_COLLECTION).doc(String(deviceId));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(401, 'Equipo no encontrado', 'INVALID_DEVICE');
  const d = snap.data() || {};
  if (d.status !== 'active') throw httpError(401, 'Equipo revocado o reemplazado', 'DEVICE_REVOKED');

  const configVersionApplied = body.configVersionApplied == null ? null : Number(body.configVersionApplied);
  const checks = body.checks && typeof body.checks === 'object' ? JSON.parse(JSON.stringify(body.checks)) : null;
  // clockMs (hora del equipo) se convierte en desfase contra la hora del servidor al recibir.
  // Con reloj bien queda en 0, así el doc no cambia en cada heartbeat.
  if (checks && typeof checks.clockMs === 'number' && Number.isFinite(checks.clockMs)) {
    const skew = checks.clockMs - now;
    delete checks.clockMs;
    checks.clockOffsetMs = Math.abs(skew) > CLOCK_SKEW_MS ? Math.round(skew / 1000) * 1000 : 0;
  }
  const prevProblems = problemSignature(d.checks, now);
  const nextProblems = problemSignature(checks, now);
  if (checks && Buffer.byteLength(JSON.stringify(checks)) > 8192) throw httpError(400, 'checks demasiado grande');
  const lanUrl = deviceKind === 'hub' ? sanitizeLanUrl(body.lanUrl) : null;

  const changed = (d.configVersionApplied ?? null) !== configVersionApplied
    || stableJson(d.checks ?? null) !== stableJson(checks)
    || (deviceKind === 'hub' && (d.lanUrl || null) !== lanUrl);
  const lastWrite = toMillis(d.lastSeenAt) || 0;
  const stale = now - lastWrite > HEARTBEAT_MIN_WRITE_INTERVAL_MS;

  let controllers = { written: 0, ignored: 0, mapChanged: false, nextMap: null };
  if (deviceKind === 'hub' && body.controllers) {
    controllers = await applyReportedControllers({
      hubData: d, hubId: deviceId, siteId, reported: normalizeReportedControllers(body.controllers), now
    });
  }

  let wrote = false;
  let siteWrote = false;
  if (changed || stale || controllers.mapChanged) {
    const update = { lastSeenAt: now, configVersionApplied, checks };
    if (deviceKind === 'hub') update.lanUrl = lanUrl;
    if (controllers.mapChanged) update.controllersReported = controllers.nextMap;
    // update (no set merge): reemplaza `checks` entero. Con merge Firestore une los mapas
    // y quedaban claves viejas (p. ej. un clockMs crudo => "Reloj desfasado" para siempre).
    await ref.update(update);
    wrote = true;
  }
  if (deviceKind === 'hub' && lanUrl && (d.lanUrl || null) !== lanUrl) {
    await siteRef(siteId).set({ lanUrl, lanUrlUpdatedAt: now }, { merge: true });
    siteWrote = true;
  }
  if (prevProblems !== nextProblems) {
    const labels = problemLabels(checks, now);
    appendDeviceLog(String(deviceId), {
      action: 'device.checks',
      message: labels.length ? `Con problemas: ${labels.join('. ')}` : 'Volvió a estar en línea',
      at: now,
      detail: labels.join('. ') || null
    }).catch((err) => console.error('[edge] bitácora checks', err.message));
  }
  return {
    ok: true,
    wrote,
    siteWrote,
    controllersWritten: controllers.written,
    controllersIgnored: controllers.ignored,
    nextHeartbeatSec: HEARTBEAT_MIN_WRITE_INTERVAL_MS / 1000
  };
};

// ───────────────────────────── Comandos ─────────────────────────────

const commandRef = (siteId, id) => {
  const cid = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(cid)) throw httpError(404, 'Comando no encontrado');
  return siteRef(siteId).collection('commands').doc(cid);
};

const commandsStatusRef = (siteId) => siteRef(siteId).collection('status').doc('commands');

/** Contador de pendientes (+1/−1). Nunca se lee acá: el clamp a ≥ 0 se hace en readPendingCommands. */
const bumpPendingCommands = (writer, siteId, delta, now) => {
  writer.set(commandsStatusRef(siteId), { pending: FieldValue.increment(delta), updatedAt: now }, { merge: true });
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
    forceReason: data.forceReason || null,
    controllerId: data.controllerId || null,
    reason: data.reason || null,
    requestedBy: data.requestedBy || null,
    createdAt: data.createdAt || null,
    expiresAt: data.expiresAt || null,
    completedAt: data.completedAt || null,
    result: data.result || null
  };
};

/** Encola una apertura remota (2 escrituras: comando + contador). La recoge el hub. */
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
  const batch = db.batch();
  batch.set(commandRef(siteId, id), data);
  bumpPendingCommands(batch, siteId, 1, now);
  await batch.commit();
  return effectiveCommand(id, data, now);
};

const getCommand = async ({ siteId, id, now = Date.now() }) => {
  const snap = await commandRef(siteId, id).get();
  if (!snap.exists) throw httpError(404, 'Comando no encontrado');
  return effectiveCommand(snap.id || id, snap.data() || {}, now);
};

/**
 * Pendientes del sitio para el hub (GET /api/edge/v1/commands?status=pending).
 * Costo: 1 query (≥ 1 lectura) + 1 escritura por comando vencido (pasa a 'expired') + el contador.
 * Solo se llama cuando `pendingCommands` > 0, así que si la query vuelve vacía se re-sincroniza
 * el contador a 0 (corrige derivas).
 */
const listPendingCommands = async ({ siteId, now = Date.now(), limit = MAX_PENDING_COMMANDS_LISTED }) => {
  const snap = await siteRef(siteId).collection('commands')
    .where('status', '==', 'pending')
    .limit(limit)
    .get();
  const pending = [];
  let expired = 0;
  const batch = db.batch();
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (Number(data.expiresAt) < now) {
      batch.set(doc.ref, { status: 'expired', expiredAt: now }, { merge: true });
      expired += 1;
      return;
    }
    pending.push(effectiveCommand(doc.id, data, now));
  });
  if (expired) bumpPendingCommands(batch, siteId, -expired, now);
  else if (!snap.docs.length) batch.set(commandsStatusRef(siteId), { pending: 0, updatedAt: now }, { merge: true });
  if (expired || !snap.docs.length) await batch.commit();
  pending.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  return { commands: pending, expired };
};

/** Normaliza el resultado del hub: `{status, result:{ok, relayConfirmed, doorOpened, code, ...}}` o plano. */
const normalizeCommandResult = (body = {}) => {
  const r = body.result && typeof body.result === 'object' ? body.result : {};
  const pick = (k) => (body[k] !== undefined ? body[k] : r[k]);
  const relay = pick('relayConfirmed');
  const opened = pick('doorOpened');
  const reason = pick('reason') ?? r.code ?? r.message ?? null;
  return {
    relayConfirmed: relay === true,
    doorOpened: opened == null ? null : opened === true,
    reason: reason ? String(reason).slice(0, 300) : null,
    ...(r.code ? { code: String(r.code).slice(0, 80) } : {}),
    ...(r.controllerId ? { controllerId: String(r.controllerId).slice(0, 120) } : {}),
    ...(r.eventId ? { eventId: String(r.eventId).slice(0, 200) } : {})
  };
};

/**
 * Resultado real del hub (idempotente: un comando terminado no se pisa). Si estaba 'pending'
 * descuenta el contador; un resultado tardío sobre un 'expired' (vencido por la nube) se guarda
 * una vez (lateResult) sin volver a descontar.
 */
const recordCommandResult = async ({ siteId, id, hubId, body = {}, now = Date.now() }) => {
  const status = String(body.status || '');
  if (!COMMAND_RESULT_STATUSES.includes(status)) {
    throw httpError(400, `status debe ser uno de: ${COMMAND_RESULT_STATUSES.join(', ')}`);
  }
  const ref = commandRef(siteId, id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, 'Comando no encontrado');
    const data = snap.data() || {};
    const wasPending = (data.status || 'pending') === 'pending';
    const final = ['done', 'failed', 'rejected'].includes(data.status)
      || (data.status === 'expired' && (status === 'expired' || Boolean(data.result)));
    if (final) return { ...effectiveCommand(id, data, now), duplicate: true };
    const update = {
      status,
      result: normalizeCommandResult(body),
      completedAt: now,
      completedBy: hubId,
      lateResult: Number(data.expiresAt) < now
    };
    tx.set(ref, update, { merge: true });
    if (wasPending) bumpPendingCommands(tx, siteId, -1, now);
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

/** Pendientes según el contador (1 lectura), acotado a ≥ 0. */
const readPendingCommands = async (siteId) => {
  const snap = await commandsStatusRef(siteId).get();
  const n = snap.exists ? Number((snap.data() || {}).pending) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const readHead = async (siteId) => {
  const compiler = requireSiteCompiler();
  const [head, pendingCommands] = await Promise.all([compiler.getHead(siteId), readPendingCommands(siteId)]);
  let publicKey = null;
  if (typeof compiler.getSigningPublicKey === 'function') {
    publicKey = await compiler.getSigningPublicKey();
  }
  const keyId = (publicKey && typeof publicKey === 'object' ? publicKey.keyId : null) || head?.keyId || null;
  const pem = publicKey && typeof publicKey === 'object' ? (publicKey.publicKeyPem || publicKey.publicKey || publicKey.pem || null)
    : (typeof publicKey === 'string' ? publicKey : null);
  return { siteId, head: head || null, keyId, publicKey: pem, pendingCommands };
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
  alarmTypeOf,
  CRITICAL_ALARM_NOTIFY,
  journalDocId,
  normalizeEvent,
  isGrantedMovement,
  buildEntryDoc,
  buildAlarmDoc,
  ingestEventBatch,
  recordHeartbeat,
  normalizeReportedControllers,
  createOpenCommand,
  getCommand,
  listPendingCommands,
  readPendingCommands,
  normalizeCommandResult,
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
