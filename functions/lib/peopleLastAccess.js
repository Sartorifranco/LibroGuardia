/**
 * Último uso de acceso por persona (lastAccessAt).
 * Se actualiza al importar eventos BioStar / validar acceso autorizado.
 */

const { db, FieldValue, Timestamp } = require('../firestore');

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value?.toDate === 'function') {
    try {
      const d = value.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'object' && value._seconds != null) {
    const d = new Date(Number(value._seconds) * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const toMillis = (value) => {
  const d = toDate(value);
  return d ? d.getTime() : null;
};

const daysSince = (value, now = new Date()) => {
  const ms = toMillis(value);
  if (ms == null) return null;
  const diff = Math.max(0, now.getTime() - ms);
  return Math.floor(diff / (24 * 60 * 60 * 1000));
};

const serializeLastAccess = (data = {}, now = new Date()) => {
  const at = toDate(data.lastAccessAt);
  return {
    lastAccessAt: at ? at.toISOString() : null,
    lastAccessSource: data.lastAccessSource || null,
    lastAccessDoorId: data.lastAccessDoorId || null,
    daysSinceAccess: daysSince(at, now)
  };
};

/**
 * Actualiza lastAccessAt solo si el evento es más reciente (o no había dato).
 * @returns {Promise<boolean>} true si escribió
 */
const touchPersonLastAccess = async (personId, at, {
  source = 'access',
  doorId = null
} = {}) => {
  const id = String(personId || '').trim();
  if (!id) return false;
  const when = toDate(at) || new Date();
  const ref = db.collection('people').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const prev = toMillis(snap.data()?.lastAccessAt);
  const next = when.getTime();
  if (prev != null && next < prev) return false;

  const patch = {
    lastAccessAt: Timestamp.fromDate(when),
    lastAccessSource: String(source || 'access').slice(0, 40),
    lastAccessTouchedAt: FieldValue.serverTimestamp()
  };
  const door = String(doorId || '').trim();
  if (door) patch.lastAccessDoorId = door;

  await ref.set(patch, { merge: true });
  return true;
};

const pickNewerLastAccess = (keepData = {}, mergeData = {}) => {
  const keepMs = toMillis(keepData.lastAccessAt);
  const mergeMs = toMillis(mergeData.lastAccessAt);
  if (keepMs == null && mergeMs == null) return null;
  if (keepMs == null) {
    return {
      lastAccessAt: mergeData.lastAccessAt,
      lastAccessSource: mergeData.lastAccessSource || null,
      lastAccessDoorId: mergeData.lastAccessDoorId || null
    };
  }
  if (mergeMs == null || keepMs >= mergeMs) {
    return {
      lastAccessAt: keepData.lastAccessAt,
      lastAccessSource: keepData.lastAccessSource || null,
      lastAccessDoorId: keepData.lastAccessDoorId || null
    };
  }
  return {
    lastAccessAt: mergeData.lastAccessAt,
    lastAccessSource: mergeData.lastAccessSource || null,
    lastAccessDoorId: mergeData.lastAccessDoorId || null
  };
};

/**
 * Filtros de limpieza por inactividad.
 * never | stale:N | known | all
 */
const matchesAccessFilter = (person = {}, accessFilter = '', now = new Date()) => {
  const raw = String(accessFilter || '').trim().toLowerCase();
  if (!raw || raw === 'all') return true;

  const days = person.daysSinceAccess != null
    ? person.daysSinceAccess
    : daysSince(person.lastAccessAt, now);
  const has = person.lastAccessAt != null || days != null;

  if (raw === 'never') return !has;
  if (raw === 'known') return has;
  if (raw.startsWith('stale:')) {
    const n = Number(raw.slice(6));
    if (!Number.isFinite(n) || n < 0) return true;
    if (!has) return true; // sin dato también es candidato a revisión
    return days >= n;
  }
  if (raw.startsWith('unused:')) {
    // Solo con dato conocido y >= N días (no incluye "nunca")
    const n = Number(raw.slice(7));
    if (!Number.isFinite(n) || n < 0) return true;
    if (!has) return false;
    return days >= n;
  }
  return true;
};

const resolvePersonIdFromEntry = async (entry = {}, bioCache = new Map()) => {
  const personId = String(entry.personId || '').trim();
  if (personId) return personId;
  const bio = String(entry.biometricExternalId || '').trim();
  if (!bio) return null;
  if (bioCache.has(bio)) return bioCache.get(bio);
  const snap = await db.collection('people')
    .where('biometricExternalId', '==', bio)
    .limit(5)
    .get();
  let resolved = null;
  if (!snap.empty) {
    const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const active = rows.find((p) => p.active !== false && !p.mergedIntoId);
    resolved = (active || rows[0])?.id || null;
    if (active?.mergedIntoId) resolved = String(active.mergedIntoId);
    const into = rows.find((p) => p.mergedIntoId)?.mergedIntoId;
    if (!resolved && into) resolved = String(into);
  }
  bioCache.set(bio, resolved);
  return resolved;
};

/**
 * Recalcula lastAccessAt desde entries (más recientes primero).
 * Procesa un lote; se puede llamar varias veces con cursor.
 */
const backfillPeopleLastAccess = async ({
  limit = 800,
  cursorMillis = null
} = {}) => {
  const batchSize = Math.min(Math.max(Number(limit) || 800, 50), 1500);
  let query = db.collection('entries')
    .where('authorized', '==', true)
    .orderBy('timestamp', 'desc')
    .limit(batchSize);

  if (cursorMillis != null && Number.isFinite(Number(cursorMillis))) {
    query = db.collection('entries')
      .where('authorized', '==', true)
      .where('timestamp', '<', Timestamp.fromMillis(Number(cursorMillis)))
      .orderBy('timestamp', 'desc')
      .limit(batchSize);
  }

  let snap;
  try {
    snap = await query.get();
  } catch (err) {
    // Fallback sin índice compuesto: lote reciente simple
    snap = await db.collection('entries').orderBy('timestamp', 'desc').limit(batchSize).get();
  }

  const bioCache = new Map();
  const seenPeople = new Set();
  let updated = 0;
  let skipped = 0;
  let examined = 0;
  let nextCursor = null;

  for (const doc of snap.docs) {
    examined += 1;
    const data = doc.data() || {};
    if (data.authorized === false || data.accessAuthorized === false) {
      skipped += 1;
      continue;
    }
    const at = toDate(data.timestamp);
    if (!at) {
      skipped += 1;
      continue;
    }
    nextCursor = at.getTime();

    const personId = await resolvePersonIdFromEntry(data, bioCache);
    if (!personId) {
      skipped += 1;
      continue;
    }
    if (seenPeople.has(personId)) {
      skipped += 1;
      continue;
    }
    seenPeople.add(personId);

    const source = data.entrySource === 'biostar'
      ? 'biostar'
      : (data.channel === 'molinete' ? 'kiosk' : (data.entrySource || 'access'));
    const wrote = await touchPersonLastAccess(personId, at, {
      source,
      doorId: data.doorId || null
    });
    if (wrote) updated += 1;
    else skipped += 1;
  }

  return {
    examined,
    updated,
    skipped,
    peopleTouched: seenPeople.size,
    nextCursorMillis: snap.size >= batchSize ? nextCursor : null,
    done: snap.size < batchSize
  };
};

module.exports = {
  toDate,
  toMillis,
  daysSince,
  serializeLastAccess,
  touchPersonLastAccess,
  pickNewerLastAccess,
  matchesAccessFilter,
  backfillPeopleLastAccess,
  resolvePersonIdFromEntry
};
