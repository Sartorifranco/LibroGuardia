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

/**
 * @param {object[]} events
 * @param {{ actorId?: string|null }} [options]
 * @returns {Promise<{ accepted: number, skipped: number, results: object[] }>}
 */
const ingestOfflineEntries = async (events = [], options = {}) => {
  if (!Array.isArray(events)) {
    throw httpError(400, 'events debe ser un array');
  }
  if (events.length === 0) {
    return { accepted: 0, skipped: 0, results: [] };
  }
  if (events.length > 500) {
    throw httpError(400, 'Máximo 500 eventos por lote');
  }

  const actorId = options.actorId || null;
  const results = [];
  let accepted = 0;
  let skipped = 0;

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
      results.push({ offlineLocalId, status: 'error', message: 'timestamp inválido' });
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
    const authorized = raw?.authorized !== false;
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
      relayTriggered: Boolean(raw?.relayTriggered)
    };

    await ref.set(payload);
    accepted += 1;
    results.push({ offlineLocalId, entryId: docId, status: 'created' });
  }

  return { accepted, skipped, results };
};

module.exports = {
  ingestOfflineEntries,
  offlineEntryDocId,
  sanitizeOfflineLocalId,
  parseEventTime
};
