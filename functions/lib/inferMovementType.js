const { db } = require('../firestore');
const { getArgentinaDateParts } = require('./normalize');
const { normalizeIdNumber } = require('../dniParser');
const { mark: profileMark } = require('./kioskProfile');

const inferNextMovementFromEntries = (entries = []) => {
  if (!entries.length) return 'ingreso';
  const lastType = entries[0].movementType || entries[0].tipoMovimiento || 'ingreso';
  return lastType === 'ingreso' ? 'egreso' : 'ingreso';
};

const isAuthorizedEntryToday = (entry, today) => {
  if (entry.type !== 'personal') return false;
  if (entry.authorized === false || entry.accessAuthorized === false) return false;
  const ts = entry.timestamp?.toDate?.() || new Date(entry.timestamp);
  if (Number.isNaN(ts.getTime())) return false;
  return getArgentinaDateParts(ts).dateString === today;
};

const filterTodayAuthorized = (docs, today, { personId, dni }) =>
  docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((entry) => {
      if (!isAuthorizedEntryToday(entry, today)) return false;
      if (personId && entry.personId === personId) return true;
      const entryDni = normalizeIdNumber(entry.idNumber || entry.dniSnapshot || '');
      return Boolean(dni && entryDni && entryDni === dni);
    });

/**
 * Primera pasada autorizada del día → ingreso; la siguiente → egreso; y así alternando.
 */
const inferMovementTypeForToday = async ({
  personId = null,
  dniNormalized = '',
  referenceDate = new Date()
} = {}) => {
  const { dateString: today } = getArgentinaDateParts(referenceDate);
  const dni = normalizeIdNumber(dniNormalized);

  if (!personId && !dni) return 'ingreso';

  if (personId) {
    const snap = await db.collection('entries')
      .where('personId', '==', personId)
      .orderBy('timestamp', 'desc')
      .limit(12)
      .get();
    profileMark('inferMovement.queryEntriesByPersonId');
    const matches = filterTodayAuthorized(snap.docs, today, { personId, dni });
    return inferNextMovementFromEntries(matches);
  }

  // Sin personId: búsqueda acotada por DNI (fallback).
  const snap = await db.collection('entries')
    .where('type', '==', 'personal')
    .orderBy('timestamp', 'desc')
    .limit(120)
    .get();
  profileMark('inferMovement.queryEntriesByTypeFallback');
  const matches = filterTodayAuthorized(snap.docs, today, { personId: null, dni });
  return inferNextMovementFromEntries(matches);
};

module.exports = {
  inferMovementTypeForToday,
  inferNextMovementFromEntries
};
