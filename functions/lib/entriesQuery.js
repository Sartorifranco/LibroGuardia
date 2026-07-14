const { Timestamp } = require('../firestore');
const { getArgentinaDateString } = require('./normalize');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const parseYmdToStart = (ymd) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return Timestamp.fromDate(new Date(`${ymd}T00:00:00-03:00`));
};

const parseYmdToEnd = (ymd) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return Timestamp.fromDate(new Date(`${ymd}T23:59:59.999-03:00`));
};

const clampLimit = (value) => {
  const n = Number(value);
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
};

const getEffectiveEntryType = (data = {}) => {
  const isGps = Boolean(data.gpsAuto || data.entrySource === 'gps_ubika');
  if (data.type === 'vehiculo' && isGps) return 'flota';
  return data.type;
};

const matchesTypeFilter = (data, typeFilter) => {
  if (!typeFilter || typeFilter === 'todos') return true;
  return getEffectiveEntryType(data) === typeFilter;
};

const matchesSearch = (data, searchTerm) => {
  const needle = String(searchTerm || '').trim().toLowerCase();
  if (!needle) return true;
  return Object.values(data || {}).some((value) => {
    if (value == null || typeof value === 'object') return false;
    return String(value).toLowerCase().includes(needle);
  });
};

/**
 * Página de entries por rango de fechas.
 * type/q se aplican en memoria sobre el lote (la paginación avanza por cursor Firestore).
 */
const queryEntriesPage = async (db, {
  startDate,
  endDate,
  limit = DEFAULT_LIMIT,
  cursor = null,
  type = 'todos',
  q = ''
} = {}) => {
  const pageLimit = clampLimit(limit);
  const todayAr = getArgentinaDateString();
  const startYmd = startDate || todayAr;
  const endYmd = endDate || startYmd;

  const startTs = parseYmdToStart(startYmd);
  const endTs = parseYmdToEnd(endYmd);
  if (!startTs || !endTs) {
    const err = new Error('Fechas inválidas. Usá formato YYYY-MM-DD.');
    err.status = 400;
    throw err;
  }

  const useTypeInQuery = type && type !== 'todos' && type !== 'flota';

  let queryRef = db.collection('entries')
    .where('timestamp', '>=', startTs)
    .where('timestamp', '<=', endTs)
    .orderBy('timestamp', 'desc');

  if (useTypeInQuery) {
    queryRef = db.collection('entries')
      .where('type', '==', type)
      .where('timestamp', '>=', startTs)
      .where('timestamp', '<=', endTs)
      .orderBy('timestamp', 'desc');
  }

  if (cursor) {
    const cursorSnap = await db.collection('entries').doc(String(cursor)).get();
    if (cursorSnap.exists) {
      queryRef = queryRef.startAfter(cursorSnap);
    }
  }

  const snap = await queryRef.limit(pageLimit + 1).get();
  const hasMore = snap.docs.length > pageLimit;
  const pageDocs = hasMore ? snap.docs.slice(0, pageLimit) : snap.docs;

  const filteredDocs = pageDocs.filter((doc) => {
    const data = doc.data();
    return matchesTypeFilter(data, type) && matchesSearch(data, q);
  });

  const nextCursor = hasMore && pageDocs.length
    ? pageDocs[pageDocs.length - 1].id
    : null;

  return {
    docs: filteredDocs,
    scannedDocs: pageDocs,
    hasMore: Boolean(nextCursor),
    nextCursor,
    startDate: startYmd,
    endDate: endYmd,
    limit: pageLimit
  };
};

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  queryEntriesPage,
  matchesTypeFilter,
  matchesSearch,
  getEffectiveEntryType,
  clampLimit
};
