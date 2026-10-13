/**
 * Ingesta de eventos de acceso registrados offline por el door-reader-bridge.
 * Idempotente por offlineLocalId (doc id determinístico).
 */

const { db, FieldValue, Timestamp } = require('../firestore');
const { normalizeDni, getArgentinaDateParts } = require('./normalize');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const sanitizeOfflineLocalId = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // Firestore doc ids: evitar '/' y limitar longitud
  return raw.replace(/\//g, '_').slice(0, 700);
};

const offlineEntryDocId = (offlineLocalId) => `offline_${sanitizeOfflineLocalId(offlineLocalId)}`;

const parseEventTime = (value) => {
  if (value == null || value === '') return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Eventos offline más viejos que esto se rechazan (la estación los descarta). */
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerancia de reloj de la mini PC hacia el futuro. */
const MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;

/**
 * Puertas que el usuario que sincroniza puede declarar (lectores vinculados).
 * Se prueba con username y con actorId (hoy el id del usuario = username).
 */
const resolveAllowedDoorIds = async ({ allowedDoorIds, username, actorId }) => {
  if (allowedDoorIds != null) {
    return new Set([...(allowedDoorIds instanceof Set ? allowedDoorIds : allowedDoorIds)]
      .map((d) => String(d || '').trim())
      .filter(Boolean));
  }
  const { listDoorIdsForKioskUser } = require('./lectores');
  const candidates = [...new Set([username, actorId]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean))];
  const result = new Set();
  for (const candidate of candidates) {
    const doors = await listDoorIdsForKioskUser(candidate);
    doors.forEach((d) => result.add(d));
  }
  return result;
};

/**
 * Los eventos offline son DECLARADOS por la estación (la nube no decidió):
 * - `authorized` ausente → false (fail-closed).
 * - timestamp > 7 días atrás o > 5 min en el futuro → rechazado.
 * - doorId no vinculado al usuario que sincroniza → rechazado.
 * - se marcan source:'offline_kiosk' / declaredByKiosk:true para reportes.
 * Los rechazos permanentes vuelven con status 'rejected' (la estación no los
 * reintenta); 'error' queda para fallas que sí conviene reintentar.
 *
 * @param {object[]} events
 * @param {{ actorId?: string|null, username?: string|null, allowedDoorIds?: string[]|Set<string>, nowMs?: number }} [options]
 * @returns {Promise<{ accepted: number, skipped: number, rejected: number, results: object[] }>}
 */
const ingestOfflineEntries = async (events = [], options = {}) => {
  if (!Array.isArray(events)) {
    throw httpError(400, 'events debe ser un array');
  }
  if (events.length === 0) {
    return { accepted: 0, skipped: 0, rejected: 0, results: [] };
  }
  if (events.length > 500) {
    throw httpError(400, 'Máximo 500 eventos por lote');
  }

  const actorId = options.actorId || null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const allowedDoors = await resolveAllowedDoorIds({
    allowedDoorIds: options.allowedDoorIds,
    username: options.username,
    actorId
  });
  const results = [];
  let accepted = 0;
  let skipped = 0;
  let rejected = 0;

  const reject = (offlineLocalId, message, extra = {}) => {
    rejected += 1;
    console.warn('[offlineEntries] Evento offline rechazado', { offlineLocalId, actorId, message, ...extra });
    results.push({ offlineLocalId, status: 'rejected', message });
  };

  for (const raw of events) {
    const offlineLocalId = sanitizeOfflineLocalId(raw?.offlineLocalId || raw?.localId);
    if (!offlineLocalId) {
      results.push({ offlineLocalId: null, status: 'error', message: 'offlineLocalId obligatorio' });
      continue;
    }

    const doorId = String(raw?.doorId || '').trim();
    if (!doorId) {
      results.push({ offlineLocalId, status: 'error', message: 'doorId obligatorio' });
      continue;
    }

    const eventDate = parseEventTime(raw?.timestamp || raw?.scannedAt);
    if (!eventDate) {
      reject(offlineLocalId, 'timestamp inválido');
      continue;
    }
    const ageMs = nowMs - eventDate.getTime();
    if (ageMs > MAX_EVENT_AGE_MS) {
      reject(offlineLocalId, 'evento offline demasiado viejo (más de 7 días)', { timestamp: eventDate.toISOString() });
      continue;
    }
    if (-ageMs > MAX_EVENT_FUTURE_MS) {
      reject(offlineLocalId, 'timestamp en el futuro (revisar hora de la mini PC)', { timestamp: eventDate.toISOString() });
      continue;
    }

    if (!allowedDoors.has(doorId)) {
      reject(offlineLocalId, 'la puerta no está vinculada a esta estación', { doorId });
      continue;
    }

    const docId = offlineEntryDocId(offlineLocalId);
    const ref = db.collection('entries').doc(docId);
    const existing = await ref.get();
    if (existing.exists) {
      skipped += 1;
      results.push({ offlineLocalId, entryId: docId, status: 'duplicate' });
      continue;
    }

    const dniSnapshot = normalizeDni(raw?.dniNormalized || raw?.dni || raw?.idNumber || '');
    const legajo = raw?.legajoNormalized || raw?.legajo || null;
    const nameSnapshot = String(raw?.nombre || raw?.name || '').trim();
    const movementType = raw?.movementType === 'egreso' ? 'egreso' : 'ingreso';
    // Fail-closed: solo cuenta como autorizado si la estación lo declara explícitamente.
    const authorized = raw?.authorized === true;
    const readerId = String(raw?.readerId || '').trim() || null;
    const arParts = getArgentinaDateParts(eventDate);

    const payload = {
      personId: raw?.personId || null,
      authorizationId: raw?.authorizationId || null,
      nameSnapshot,
      dniSnapshot: dniSnapshot || null,
      legajoNormalized: legajo ? String(legajo).trim() : null,
      tipoMovimiento: movementType,
      movementType,
      channel: 'molinete',
      authorized: Boolean(authorized),
      denialReason: authorized ? null : (raw?.denialReason || 'offline_deny'),
      guardId: actorId,
      timestamp: Timestamp.fromDate(eventDate),
      notes: null,
      type: 'personal',
      name: nameSnapshot,
      idNumber: dniSnapshot || '',
      entrySource: 'kiosk_offline',
      accessAuthorized: Boolean(authorized),
      accessReason: authorized
        ? (raw?.authorizationType || 'offline_allowlist')
        : (raw?.denialReason || 'offline_deny'),
      authorizationType: raw?.authorizationType || null,
      registeredBy: actorId,
      eventTime: arParts.timeString,
      doorId,
      readerId,
      offlineLocalId,
      offlineSyncedAt: FieldValue.serverTimestamp(),
      relayMode: 'local',
      relayTriggered: Boolean(raw?.relayTriggered),
      // Decisión tomada por la estación sin la nube: distinguible en reportes.
      source: 'offline_kiosk',
      declaredByKiosk: true
    };

    await ref.set(payload);
    accepted += 1;
    results.push({ offlineLocalId, entryId: docId, status: 'created' });
  }

  return { accepted, skipped, rejected, results };
};

module.exports = {
  MAX_EVENT_AGE_MS,
  MAX_EVENT_FUTURE_MS,
  ingestOfflineEntries,
  offlineEntryDocId,
  sanitizeOfflineLocalId,
  parseEventTime
};
