/**
 * Importación BioStar 2 → MSS Guard (usuarios + eventos).
 */

const { db, FieldValue, Timestamp } = require('../firestore');
const { normalizeDni, getArgentinaDateParts } = require('./normalize');
const { normalizeIdNumber } = require('../dniParser');
const { buildNameTokens } = require('./nameUtils');
const { buildNameKeyWithInitials } = require('./personIdentity');
const { findPersonByDni } = require('../people');
const {
  extractBiostarDniCandidates,
  biostarDisplayName
} = require('./biostarMatch');
const { normalizeCategory } = require('./peopleAlerts');

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

const findPersonByDniAny = async (dniNormalized) => {
  const dni = normalizeIdNumber(dniNormalized);
  if (!dni) return null;
  // Prefer active
  const active = await findPersonByDni(dni);
  if (active) return { id: active.id, ...active.data() };
  const snap = await db.collection('people')
    .where('dniNormalized', '==', dni)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() || {}) };
};

const resolveDoorGrant = (existingDoors, defaultDoorId, { forceDoor = false } = {}) => {
  const doors = Array.isArray(existingDoors) ? [...existingDoors] : [];
  const door = String(defaultDoorId || '').trim();
  if (!door) return doors;
  if (forceDoor || doors.length === 0) {
    if (!doors.includes(door)) doors.push(door);
  }
  return doors;
};

/**
 * Upsert personas desde filas BioStar UserCollection.
 * Match: biometricExternalId, luego DNI detectado; si no, huérfano sin_clasificar.
 */
const importBiostarUsers = async (users = [], options = {}) => {
  if (!Array.isArray(users)) throw httpError(400, 'users debe ser un array');
  if (users.length > 2000) throw httpError(400, 'Máximo 2000 usuarios por lote');

  const defaultDoorId = String(options.defaultDoorId || '').trim() || null;
  const results = [];
  let created = 0;
  let updated = 0;
  let linkedByDni = 0;
  let skipped = 0;
  const suggestions = [];

  for (const raw of users) {
    const userId = String(raw?.user_id || raw?.userId || '').trim();
    if (!userId) {
      skipped += 1;
      results.push({ status: 'skipped', message: 'sin user_id' });
      continue;
    }
    const name = biostarDisplayName(raw, userId);
    const disabled = String(raw?.disabled) === 'true' || raw?.disabled === true;
    const dniCandidates = extractBiostarDniCandidates(raw);
    const primaryDni = dniCandidates[0]?.dni || null;

    let existing = await findPersonByBiometricId(userId);
    let matchedBy = existing ? 'biometric' : null;

    if (!existing && primaryDni) {
      existing = await findPersonByDniAny(primaryDni);
      if (existing) {
        matchedBy = 'dni';
        linkedByDni += 1;
      }
    }

    if (existing) {
      const hadDoors = Array.isArray(existing.allowedDoorIds) && existing.allowedDoorIds.length > 0;
      const isOrphanStyle = existing.source === 'biostar' && !existing.dniNormalized;
      const patch = {
        name: existing.dniNormalized || existing.idNumber
          ? (existing.name || existing.nombre || name)
          : name,
        nombre: existing.dniNormalized || existing.idNumber
          ? (existing.nombre || existing.name || name)
          : name,
        biometricExternalId: userId,
        biometricBrand: 'suprema',
        biostarUserId: userId,
        active: !disabled,
        updatedAt: FieldValue.serverTimestamp(),
        source: existing.source === 'biostar' && !existing.dniNormalized
          ? 'biostar'
          : (existing.source || 'biostar_link'),
        category: normalizeCategory(existing.category, {
          ...existing,
          source: existing.source,
          dniNormalized: existing.dniNormalized || primaryDni
        })
      };
      if (primaryDni && !existing.dniNormalized) {
        patch.dni = primaryDni;
        patch.dniNormalized = primaryDni;
        patch.idNumber = primaryDni;
        patch.idNumberNormalized = primaryDni;
        patch.category = normalizeCategory(existing.category, {
          ...existing,
          dniNormalized: primaryDni,
          tipo: 'empleado'
        });
      }
      // Huérfanos BioStar: siempre solo la puerta del lector (nunca “todas”).
      // Si ya tenía puertas legítimas (empleado linkeado), no tocar.
      if (defaultDoorId && isOrphanStyle) {
        patch.allowedDoorIds = [defaultDoorId];
      } else if (defaultDoorId && !hadDoors) {
        patch.allowedDoorIds = resolveDoorGrant(existing.allowedDoorIds, defaultDoorId);
      }
      if (!existing.nameKey && name) {
        patch.nameKey = buildNameKeyWithInitials(name) || buildNameTokens(name);
        patch.nameTokens = patch.nameKey;
      }
      await db.collection('people').doc(existing.id).set(patch, { merge: true });
      updated += 1;
      results.push({
        status: 'updated',
        personId: existing.id,
        biometricExternalId: userId,
        matchedBy
      });
      continue;
    }

    // Sin match: crear huérfano
    const ref = db.collection('people').doc();
    const doc = {
      name,
      nombre: name,
      nameKey: buildNameKeyWithInitials(name) || buildNameTokens(name),
      nameTokens: buildNameKeyWithInitials(name) || buildNameTokens(name),
      biometricExternalId: userId,
      biometricBrand: 'suprema',
      biostarUserId: userId,
      active: !disabled,
      allowedDoorIds: defaultDoorId ? [defaultDoorId] : [],
      source: 'biostar',
      category: primaryDni ? 'empleado' : 'sin_clasificar',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (primaryDni) {
      doc.dni = primaryDni;
      doc.dniNormalized = primaryDni;
      doc.idNumber = primaryDni;
      doc.idNumberNormalized = primaryDni;
    } else {
      suggestions.push({
        personId: ref.id,
        biometricExternalId: userId,
        name,
        reason: 'no_dni_match'
      });
    }
    await ref.set(doc);
    created += 1;
    results.push({
      status: 'created',
      personId: ref.id,
      biometricExternalId: userId,
      category: doc.category
    });
  }

  return {
    created,
    updated,
    linkedByDni,
    skipped,
    total: users.length,
    suggestionsQueued: suggestions.length,
    results
  };
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
  eventDocId,
  extractBiostarDniCandidates
};
