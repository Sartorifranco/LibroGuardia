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
    .limit(10)
    .get();
  if (snap.empty) return null;

  const rows = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  // Preferir activa y no fusionada (evita reactivar fichas mergeadas).
  const best = pickBestPersonRow(rows);
  if (best) return best;

  // Si solo hay fusionadas, seguir el enlace al canónico.
  for (const row of rows) {
    const into = String(row.mergedIntoId || '').trim();
    if (!into) continue;
    const keepSnap = await db.collection('people').doc(into).get();
    if (keepSnap.exists) {
      return { id: keepSnap.id, ...(keepSnap.data() || {}) };
    }
  }

  // Último recurso: la primera fila (no debería reactivar merged).
  return rows[0];
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

    // Si caímos en una ficha ya fusionada, trabajar sobre el canónico.
    if (existing?.mergedIntoId) {
      const keepSnap = await db.collection('people').doc(String(existing.mergedIntoId)).get();
      if (keepSnap.exists) {
        existing = { id: keepSnap.id, ...(keepSnap.data() || {}) };
        matchedBy = matchedBy || 'merged_redirect';
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
    // TODO(decisión del dueño): hoy el huérfano sin DNI recibe la puerta por defecto
    // (allowedDoorIds = [defaultDoorId]). Pendiente definir si debe quedar sin puertas
    // hasta que alguien lo clasifique. No se cambia el comportamiento hasta esa decisión.
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

/** Tamaño de lote recomendado: 50 eventos entran holgados en el corte de 60 s de Hosting. */
const DEFAULT_EVENTS_BATCH_SIZE = 50;
const MAX_EVENTS_PER_REQUEST = 500;
/** Presupuesto de tiempo por request: si se pasa, se corta y se devuelve éxito parcial. */
const DEFAULT_TIME_BUDGET_MS = 40 * 1000;
/** Límite de `where in` de Firestore. */
const IN_QUERY_CHUNK = 30;
/** Firestore admite 500 operaciones por batch; dejamos margen. */
const WRITE_BATCH_LIMIT = 450;

/**
 * Códigos BioStar 2 (event_type_id.code, decimal).
 * 0x1000–0x19FF = eventos de identificación de una persona:
 *   0x1000 verificación OK, 0x1100 verificación fallida, 0x1200 coacción (verify),
 *   0x1300 identificación OK, 0x1400 identificación fallida, 0x1500 coacción (identify),
 *   0x1600 doble autenticación OK, 0x1700 doble autenticación fallida,
 *   0x1800 autenticación fallida, 0x1900 acceso denegado.
 * El resto (puerta forzada, mantenida abierta, equipo desconectado, etc.) son
 * eventos de equipo: no son pases de una persona.
 */
const IDENTIFICATION_CODE_MIN = 0x1000;
const IDENTIFICATION_CODE_MAX = 0x19FF;
const SUCCESS_CODE_RANGES = [
  [0x1000, 0x10FF],
  [0x1200, 0x13FF],
  [0x1500, 0x16FF]
];

const inRanges = (n, ranges) => ranges.some(([a, b]) => n >= a && n <= b);

const classifyBiostarEventCode = (code, successCodes = new Set()) => {
  const str = String(code || '').trim();
  const n = Number(str);
  const configuredSuccess = Boolean(str) && successCodes.has(str);
  const isIdentification = configuredSuccess
    || (Number.isInteger(n) && n >= IDENTIFICATION_CODE_MIN && n <= IDENTIFICATION_CODE_MAX);
  if (!isIdentification) return { isIdentification: false, authorized: false };
  const authorized = configuredSuccess || (Number.isInteger(n) && inRanges(n, SUCCESS_CODE_RANGES));
  return { isIdentification: true, authorized };
};

/** door_id puede venir como {id}, [{id}] o escalar según versión de BioStar. */
const extractBiostarDoorId = (raw) => {
  const value = raw?.door_id ?? raw?.doorId;
  const first = Array.isArray(value) ? value[0] : value;
  if (first == null) return '';
  if (typeof first === 'object') return String(first.id ?? first.door_id ?? '').trim();
  return String(first).trim();
};

const extractBiostarDeviceId = (raw) => {
  const value = raw?.device_id ?? raw?.deviceId;
  if (value == null) return '';
  if (typeof value === 'object') return String(value.id ?? value.device_id ?? '').trim();
  return String(value).trim();
};

const extractBiostarUserId = (raw) => {
  const value = raw?.user_id ?? raw?.userId;
  if (value == null) return '';
  if (typeof value === 'object') return String(value.user_id ?? value.id ?? '').trim();
  return String(value).trim();
};

const extractBiostarEventCode = (raw) => String(
  raw?.event_type_id?.code
  ?? raw?.event_type_code
  ?? (typeof raw?.event_type_id !== 'object' ? raw?.event_type_id : '')
  ?? ''
).trim();

const DIRECTIONS = new Set(['ingreso', 'egreso']);

/**
 * Sentido del pase:
 * 1) devices[deviceId].direction configurado en el puente (equipo de solo entrada o solo salida);
 * 2) tna_key de BioStar (1 = ingreso, 2 = egreso) si el equipo lo manda;
 * 3) si no se sabe: 'ingreso' marcado como dirección desconocida.
 */
const resolveBiostarDirection = (raw, deviceCfg = null) => {
  const fromDevice = String(deviceCfg?.direction || '').trim().toLowerCase();
  if (DIRECTIONS.has(fromDevice)) {
    return { direction: fromDevice, source: 'device', unknown: false };
  }
  const tna = Number(raw?.tna_key ?? raw?.tnaKey);
  if (tna === 1) return { direction: 'ingreso', source: 'tna_key', unknown: false };
  if (tna === 2) return { direction: 'egreso', source: 'tna_key', unknown: false };
  return { direction: 'ingreso', source: null, unknown: true };
};

const pickBestPersonRow = (rows = []) => {
  const active = rows.filter((p) => p.active !== false && !p.mergedIntoId);
  if (!active.length) return null;
  const score = (p) => {
    let s = 0;
    if (p.dniNormalized || p.idNumber) s += 5;
    if (p.legajo || p.legajoNormalized) s += 3;
    if (p.source && p.source !== 'biostar') s += 2;
    return s;
  };
  return [...active].sort((a, b) => score(b) - score(a))[0];
};

/**
 * Personas por biometricExternalId para todo el lote: consultas `in` de a 30
 * (en vez de una consulta por evento). Fichas fusionadas siguen al canónico con un getAll.
 * @returns {Promise<Map<string, object>>} biometricExternalId → persona
 */
const loadPeopleByBiometricIds = async (ids = []) => {
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  const byCode = new Map();
  if (!unique.length) return byCode;

  const chunks = [];
  for (let i = 0; i < unique.length; i += IN_QUERY_CHUNK) {
    chunks.push(unique.slice(i, i + IN_QUERY_CHUNK));
  }
  const snaps = await Promise.all(chunks.map((chunk) => db.collection('people')
    .where('biometricExternalId', 'in', chunk)
    .get()));

  const rowsByCode = new Map();
  snaps.forEach((snap) => {
    snap.docs.forEach((doc) => {
      const row = { id: doc.id, ...(doc.data() || {}) };
      const code = String(row.biometricExternalId || '').trim();
      if (!rowsByCode.has(code)) rowsByCode.set(code, []);
      rowsByCode.get(code).push(row);
    });
  });

  const needCanonical = new Map();
  rowsByCode.forEach((rows, code) => {
    const best = pickBestPersonRow(rows);
    if (best) {
      byCode.set(code, best);
      return;
    }
    const into = rows.map((r) => String(r.mergedIntoId || '').trim()).find(Boolean);
    if (into) needCanonical.set(code, into);
    else byCode.set(code, rows[0]);
  });

  if (needCanonical.size) {
    const keepIds = [...new Set(needCanonical.values())];
    const refs = keepIds.map((id) => db.collection('people').doc(id));
    const keepSnaps = await db.getAll(...refs);
    const keepById = new Map();
    keepSnaps.forEach((snap) => {
      if (snap.exists) keepById.set(snap.id, { id: snap.id, ...(snap.data() || {}) });
    });
    needCanonical.forEach((into, code) => {
      if (keepById.has(into)) byCode.set(code, keepById.get(into));
      else byCode.set(code, rowsByCode.get(code)[0]);
    });
  }

  return byCode;
};

/** Subconjunto chico del evento crudo para deviceEvents (sin fotos ni blobs). */
const pickRawEventSubset = (raw = {}) => {
  const out = {};
  const deviceName = raw?.device_id?.name;
  const doorValue = Array.isArray(raw?.door_id) ? raw.door_id[0] : raw?.door_id;
  const doorName = doorValue && typeof doorValue === 'object' ? doorValue.name : null;
  if (deviceName) out.deviceName = String(deviceName).slice(0, 120);
  if (doorName) out.doorName = String(doorName).slice(0, 120);
  if (raw?.index != null) out.index = String(raw.index).slice(0, 40);
  const userId = extractBiostarUserId(raw);
  if (userId) out.userId = userId.slice(0, 80);
  if (raw?.tna_key != null) out.tnaKey = String(raw.tna_key).slice(0, 10);
  if (raw?.server_datetime) out.serverDatetime = String(raw.server_datetime).slice(0, 40);
  return out;
};

const normalizeDevicesMap = (devices) => {
  if (!devices || typeof devices !== 'object' || Array.isArray(devices)) return {};
  const out = {};
  Object.entries(devices).forEach(([key, value]) => {
    const id = String(key || '').trim();
    if (!id || !value || typeof value !== 'object') return;
    const doorId = String(value.doorId || '').trim() || null;
    const direction = String(value.direction || '').trim().toLowerCase();
    out[id] = {
      doorId,
      direction: DIRECTIONS.has(direction) ? direction : null
    };
  });
  return out;
};

/**
 * Importa eventos BioStar (idempotente por id de evento).
 * - Pases de identificación → `entries` (doc biostar_<id>).
 * - Eventos de equipo (puerta forzada, desconexión, etc.) → `deviceEvents` (no son denegados).
 *
 * Rápido: 1 getAll para existencia, consultas `in` de personas y escrituras en batch.
 * Corta por presupuesto de tiempo y devuelve éxito parcial (`partial`, `processed`)
 * con el cursor del último evento procesado, para que el puente avance igual.
 */
const importBiostarEvents = async (events = [], options = {}) => {
  if (!Array.isArray(events)) throw httpError(400, 'events debe ser un array');
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    throw httpError(400, `Máximo ${MAX_EVENTS_PER_REQUEST} eventos por lote`);
  }

  const doorMap = options.doorMap && typeof options.doorMap === 'object' ? options.doorMap : {};
  const devices = normalizeDevicesMap(options.devices);
  const defaultDoorId = String(options.defaultDoorId || '').trim() || null;
  const successCodes = new Set(
    (options.successEventCodes || ['4867', '4102']).map((c) => String(c))
  );
  const chunkSize = Math.max(1, Math.min(
    MAX_EVENTS_PER_REQUEST,
    Number(options.chunkSize) || DEFAULT_EVENTS_BATCH_SIZE
  ));
  const timeBudgetMs = Number(options.timeBudgetMs) > 0
    ? Number(options.timeBudgetMs)
    : DEFAULT_TIME_BUDGET_MS;
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = nowFn();

  const results = [];
  let accepted = 0;
  let deviceEventsStored = 0;
  let skipped = 0;
  let processed = 0;
  let partial = false;
  let maxDatetime = options.cursorDatetime || null;
  let lastEventId = null;

  for (let offset = 0; offset < events.length; offset += chunkSize) {
    if (offset > 0 && nowFn() - startedAt >= timeBudgetMs) {
      partial = true;
      break;
    }
    const chunk = events.slice(offset, offset + chunkSize);

    // 1) Parsear y clasificar sin tocar Firestore.
    const parsed = [];
    chunk.forEach((raw) => {
      const eventId = String(raw?.id || raw?.event_id || '').trim();
      if (!eventId) {
        skipped += 1;
        results.push({ status: 'error', message: 'evento sin id' });
        return;
      }
      const datetime = parseEventTime(raw?.datetime || raw?.server_datetime);
      if (!datetime) {
        skipped += 1;
        results.push({ status: 'error', eventId, message: 'datetime inválido' });
        return;
      }
      const eventCode = extractBiostarEventCode(raw);
      const { isIdentification, authorized } = classifyBiostarEventCode(eventCode, successCodes);
      const deviceId = extractBiostarDeviceId(raw);
      const biostarDoorId = extractBiostarDoorId(raw);
      const deviceCfg = deviceId ? devices[deviceId] || null : null;
      const doorId = deviceCfg?.doorId
        || (biostarDoorId && doorMap[biostarDoorId])
        || defaultDoorId
        || null;
      parsed.push({
        raw,
        eventId,
        datetime,
        eventCode,
        isIdentification,
        authorized,
        deviceId,
        deviceCfg,
        biostarDoorId,
        doorId,
        biostarUserId: extractBiostarUserId(raw),
        collection: isIdentification ? 'entries' : 'deviceEvents'
      });
    });

    // 2) Existencia en una sola lectura (getAll).
    const existingIds = new Set();
    if (parsed.length) {
      const refs = parsed.map((p) => db.collection(p.collection).doc(eventDocId(p.eventId)));
      const snaps = await db.getAll(...refs);
      snaps.forEach((snap, i) => {
        if (snap.exists) existingIds.add(`${parsed[i].collection}/${parsed[i].eventId}`);
      });
    }

    // 3) Personas del lote en consultas `in`.
    const needPeople = parsed
      .filter((p) => p.isIdentification && p.biostarUserId
        && !existingIds.has(`entries/${p.eventId}`))
      .map((p) => p.biostarUserId);
    const peopleByCode = await loadPeopleByBiometricIds(needPeople);

    // 4) Escrituras en batch.
    let batch = db.batch();
    let ops = 0;
    const commits = [];
    const queueWrite = (ref, data) => {
      batch.set(ref, data);
      ops += 1;
      if (ops >= WRITE_BATCH_LIMIT) {
        commits.push(batch.commit());
        batch = db.batch();
        ops = 0;
      }
    };

    const seenInChunk = new Set();
    parsed.forEach((p) => {
      const key = `${p.collection}/${p.eventId}`;
      if (existingIds.has(key) || seenInChunk.has(key)) {
        skipped += 1;
        results.push({ status: 'duplicate', eventId: p.eventId });
        return;
      }
      seenInChunk.add(key);
      const docId = eventDocId(p.eventId);

      if (!p.isIdentification) {
        queueWrite(db.collection('deviceEvents').doc(docId), {
          source: 'biostar',
          deviceId: p.deviceId || null,
          doorId: p.doorId,
          biostarDoorId: p.biostarDoorId || null,
          code: p.eventCode || null,
          at: Timestamp.fromDate(p.datetime),
          biostarEventId: p.eventId,
          raw: pickRawEventSubset(p.raw),
          createdAt: FieldValue.serverTimestamp()
        });
        deviceEventsStored += 1;
        results.push({ status: 'device_event', eventId: p.eventId, code: p.eventCode || null });
        return;
      }

      if (!p.doorId) {
        skipped += 1;
        results.push({ status: 'skipped', eventId: p.eventId, message: 'sin doorId mapeado' });
        return;
      }

      const person = p.biostarUserId ? peopleByCode.get(p.biostarUserId) || null : null;
      const nameSnapshot = String(
        person?.name
        || person?.nombre
        || p.raw?.user_id?.name
        || p.biostarUserId
        || 'BioStar'
      ).trim();
      const arParts = getArgentinaDateParts(p.datetime);
      const dir = resolveBiostarDirection(p.raw, p.deviceCfg);
      const { authorized, eventCode } = p;

      queueWrite(db.collection('entries').doc(docId), {
        personId: person?.id || null,
        nameSnapshot,
        dniSnapshot: normalizeDni(person?.idNumber || person?.dniNormalized || '') || null,
        tipoMovimiento: dir.direction,
        movementType: dir.direction,
        directionInferred: false,
        direccionDesconocida: dir.unknown,
        directionSource: dir.source,
        channel: 'molinete',
        authorized,
        denialReason: authorized ? null : `biostar_event_${eventCode || 'deny'}`,
        timestamp: Timestamp.fromDate(p.datetime),
        type: 'personal',
        name: nameSnapshot,
        idNumber: normalizeDni(person?.idNumber || '') || '',
        entrySource: 'biostar',
        accessAuthorized: authorized,
        accessReason: authorized ? 'biostar_verify' : `biostar_event_${eventCode || 'deny'}`,
        eventTime: arParts.timeString,
        doorId: p.doorId,
        readerId: null,
        biometricExternalId: p.biostarUserId || null,
        biostarEventId: p.eventId,
        biostarEventCode: eventCode || null,
        biostarDoorId: p.biostarDoorId || null,
        biostarDeviceId: p.deviceId || null,
        biostarSyncedAt: FieldValue.serverTimestamp(),
        relayMode: 'device',
        relayTriggered: authorized
      });
      accepted += 1;
      results.push({
        status: 'created',
        eventId: p.eventId,
        doorId: p.doorId,
        biometricExternalId: p.biostarUserId || null
      });
    });

    if (ops > 0) commits.push(batch.commit());
    await Promise.all(commits);

    // El cursor avanza solo con lo ya escrito (BioStar entrega en orden ascendente).
    parsed.forEach((p) => {
      const iso = p.datetime.toISOString();
      if (!maxDatetime || iso > maxDatetime) maxDatetime = iso;
      lastEventId = p.eventId;
    });
    processed += chunk.length;
  }

  return {
    accepted,
    deviceEvents: deviceEventsStored,
    skipped,
    total: events.length,
    processed,
    partial,
    cursorDatetime: maxDatetime,
    lastEventId,
    results
  };
};

module.exports = {
  importBiostarUsers,
  importBiostarEvents,
  classifyBiostarEventCode,
  resolveBiostarDirection,
  loadPeopleByBiometricIds,
  DEFAULT_EVENTS_BATCH_SIZE,
  findPersonByBiometricId,
  eventDocId,
  extractBiostarDniCandidates
};
