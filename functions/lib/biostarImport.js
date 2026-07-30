/**
 * Importación BioStar 2 → MSS Guard (usuarios + eventos).
 */

const { db, FieldValue, Timestamp } = require('../firestore');
const { normalizeDni, getArgentinaDateParts } = require('./normalize');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const findPersonByBiometricId = async (biometricExternalId) => {
  const code = String(biometricExternalId || '').trim();
  if (!code) return null;
  const snap = await db.collection('people')
    .where('biometricExternalId', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() || {}) };
};

/**
 * Upsert personas desde filas BioStar UserCollection.
 * biometricExternalId = user_id de BioStar.
 */
const importBiostarUsers = async (users = [], options = {}) => {
  if (!Array.isArray(users)) throw httpError(400, 'users debe ser un array');
  if (users.length > 2000) throw httpError(400, 'Máximo 2000 usuarios por lote');

  const defaultDoorId = String(options.defaultDoorId || '').trim() || null;
  const results = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of users) {
    const userId = String(raw?.user_id || raw?.userId || '').trim();
    if (!userId) {
      skipped += 1;
      results.push({ status: 'skipped', message: 'sin user_id' });
      continue;
    }
    const name = String(raw?.name || raw?.user_id || '').trim() || `BioStar ${userId}`;
    const disabled = String(raw?.disabled) === 'true' || raw?.disabled === true;
    const existing = await findPersonByBiometricId(userId);

    if (existing) {
      const patch = {
        name,
        nombre: name,
        biometricBrand: 'suprema',
        biostarUserId: userId,
        active: !disabled,
        updatedAt: FieldValue.serverTimestamp(),
        source: 'biostar'
      };
      if (defaultDoorId) {
        const doors = Array.isArray(existing.allowedDoorIds) ? [...existing.allowedDoorIds] : [];
        if (!doors.includes(defaultDoorId)) {
          doors.push(defaultDoorId);
          patch.allowedDoorIds = doors;
        }
      }
      await db.collection('people').doc(existing.id).set(patch, { merge: true });
      updated += 1;
      results.push({ status: 'updated', personId: existing.id, biometricExternalId: userId });
      continue;
    }

    const ref = db.collection('people').doc();
    const doc = {
      name,
      nombre: name,
      biometricExternalId: userId,
      biometricBrand: 'suprema',
      biostarUserId: userId,
      active: !disabled,
      allowedDoorIds: defaultDoorId ? [defaultDoorId] : [],
      source: 'biostar',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await ref.set(doc);
    created += 1;
    results.push({ status: 'created', personId: ref.id, biometricExternalId: userId });
  }

  return { created, updated, skipped, total: users.length, results };
};

const parseEventTime = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const eventDocId = (eventId) => `biostar_${String(eventId || '').replace(/\//g, '_').slice(0, 700)}`;

/**
 * Importa eventos BioStar como entries (idempotente por id de evento).
 */
const importBiostarEvents = async (events = [], options = {}) => {
  if (!Array.isArray(events)) throw httpError(400, 'events debe ser un array');
  if (events.length > 500) throw httpError(400, 'Máximo 500 eventos por lote');

  const doorMap = options.doorMap && typeof options.doorMap === 'object' ? options.doorMap : {};
  const defaultDoorId = String(options.defaultDoorId || '').trim() || null;
  const successCodes = new Set(
    (options.successEventCodes || ['4867', '4102', '1']).map((c) => String(c))
  );

  const results = [];
  let accepted = 0;
  let skipped = 0;
  let maxDatetime = options.cursorDatetime || null;

  for (const raw of events) {
    const eventId = String(raw?.id || raw?.event_id || '').trim();
    if (!eventId) {
      skipped += 1;
      results.push({ status: 'error', message: 'evento sin id' });
      continue;
    }

    const datetime = parseEventTime(raw?.datetime || raw?.server_datetime);
    if (!datetime) {
      skipped += 1;
      results.push({ status: 'error', eventId, message: 'datetime inválido' });
      continue;
    }
    const iso = datetime.toISOString();
    if (!maxDatetime || iso > maxDatetime) maxDatetime = iso;

    const docId = eventDocId(eventId);
    const ref = db.collection('entries').doc(docId);
    const existing = await ref.get();
    if (existing.exists) {
      skipped += 1;
      results.push({ status: 'duplicate', eventId });
      continue;
    }

    const biostarUserId = String(
      raw?.user_id?.user_id
      || raw?.user_id
      || raw?.userId
      || ''
    ).trim();
    const biostarDoorId = String(
      raw?.door_id?.id
      || raw?.door_id
      || raw?.doorId
      || ''
    ).trim();
    const doorId = (biostarDoorId && doorMap[biostarDoorId])
      || defaultDoorId
      || null;
    if (!doorId) {
      skipped += 1;
      results.push({ status: 'skipped', eventId, message: 'sin doorId mapeado' });
      continue;
    }

    const eventCode = String(
      raw?.event_type_id?.code
      || raw?.event_type_code
      || raw?.event_type_id
      || ''
    ).trim();
    const authorized = successCodes.size === 0
      ? true
      : successCodes.has(eventCode);

    let person = null;
    if (biostarUserId) {
      person = await findPersonByBiometricId(biostarUserId);
    }

    const nameSnapshot = String(
      person?.name
      || person?.nombre
      || raw?.user_id?.name
      || biostarUserId
      || 'BioStar'
    ).trim();
    const arParts = getArgentinaDateParts(datetime);

    await ref.set({
      personId: person?.id || null,
      nameSnapshot,
      dniSnapshot: normalizeDni(person?.idNumber || person?.dniNormalized || '') || null,
      tipoMovimiento: 'ingreso',
      movementType: 'ingreso',
      channel: 'molinete',
      authorized,
      denialReason: authorized ? null : `biostar_event_${eventCode || 'deny'}`,
      timestamp: Timestamp.fromDate(datetime),
      type: 'personal',
      name: nameSnapshot,
      idNumber: normalizeDni(person?.idNumber || '') || '',
      entrySource: 'biostar',
      accessAuthorized: authorized,
      accessReason: authorized ? 'biostar_verify' : `biostar_event_${eventCode || 'deny'}`,
      eventTime: arParts.timeString,
      doorId,
      readerId: null,
      biometricExternalId: biostarUserId || null,
      biostarEventId: eventId,
      biostarEventCode: eventCode || null,
      biostarDoorId: biostarDoorId || null,
      biostarSyncedAt: FieldValue.serverTimestamp(),
      relayMode: 'device',
      relayTriggered: authorized
    });

    accepted += 1;
    results.push({ status: 'created', eventId, doorId, biometricExternalId: biostarUserId || null });
  }

  return { accepted, skipped, total: events.length, cursorDatetime: maxDatetime, results };
};

module.exports = {
  importBiostarUsers,
  importBiostarEvents,
  findPersonByBiometricId,
  eventDocId
};
