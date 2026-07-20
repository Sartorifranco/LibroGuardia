/**
 * Reportes gerenciales — agregación server-side sobre entries / accessEvents.
 *
 * Agregación AL VUELO (no pre-cálculo diario):
 * Para una planta típica (cientos a unos pocos miles de movimientos/día),
 * un rango de 7–30 días cabe en memoria y en una query acotada por timestamp.
 * Pre-agregar por día tendría sentido si el volumen supera ~50–100k docs por
 * consulta o si varios gerentes abren reportes concurrentes cada minuto.
 * Hasta ~10–20k docs por request (~1–2 meses de operación intensa) este enfoque
 * aguanta bien; más allá conviene un doc diario `reportDaily/{ymd}`.
 */

const { Timestamp } = require('./firestore');
const { getArgentinaDateString } = require('./lib/normalize');
const { getEffectiveEntryType } = require('./lib/entriesQuery');

const REPORTS_PERMISSION = 'reports.export';
const MAX_RANGE_DAYS = 93;
const PAGE_SIZE = 500;
const MAX_DOCS = 20000;

const parseYmdToStart = (ymd) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return Timestamp.fromDate(new Date(`${ymd}T00:00:00-03:00`));
};

const parseYmdToEnd = (ymd) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return Timestamp.fromDate(new Date(`${ymd}T23:59:59.999-03:00`));
};

const daysBetween = (fromYmd, toYmd) => {
  const a = new Date(`${fromYmd}T12:00:00-03:00`);
  const b = new Date(`${toYmd}T12:00:00-03:00`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
};

const eachYmdInRange = (fromYmd, toYmd) => {
  const out = [];
  const cursor = new Date(`${fromYmd}T12:00:00-03:00`);
  const end = new Date(`${toYmd}T12:00:00-03:00`);
  while (cursor <= end) {
    out.push(getArgentinaDateString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
};

const emptyDayBucket = () => ({
  personalIngreso: 0,
  personalEgreso: 0,
  vehiculoIngreso: 0,
  vehiculoEgreso: 0,
  flotaIngreso: 0,
  flotaEgreso: 0
});

const toJsDate = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const fetchAllInRange = async (db, collectionName, field, startTs, endTs) => {
  const docs = [];
  let lastDoc = null;

  while (docs.length < MAX_DOCS) {
    let queryRef = db.collection(collectionName)
      .where(field, '>=', startTs)
      .where(field, '<=', endTs)
      .orderBy(field, 'asc')
      .limit(PAGE_SIZE);

    if (lastDoc) queryRef = queryRef.startAfter(lastDoc);

    const snap = await queryRef.get();
    if (snap.empty) break;

    docs.push(...snap.docs);
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) break;
  }

  return docs;
};

/**
 * Agrega docs ya materializados (útil para tests sin Firestore).
 */
const aggregateReports = ({
  entryDocs = [],
  accessEventDocs = [],
  from,
  to
} = {}) => {
  const days = eachYmdInRange(from, to);
  const byDay = Object.fromEntries(days.map((d) => [d, emptyDayBucket()]));

  const totals = {
    personal: { ingreso: 0, egreso: 0 },
    vehiculo: { ingreso: 0, egreso: 0 },
    flota: { ingreso: 0, egreso: 0 },
    exceptionalEntries: 0,
    entriesScanned: 0,
    denialsScanned: 0
  };

  entryDocs.forEach((doc) => {
    const data = typeof doc.data === 'function' ? doc.data() : doc;
    const ts = toJsDate(data.timestamp);
    if (!ts) return;
    const ymd = getArgentinaDateString(ts);
    if (!byDay[ymd]) return;

    totals.entriesScanned += 1;
    if (data.exceptionalEntry === true) totals.exceptionalEntries += 1;

    const effective = getEffectiveEntryType(data);
    if (!['personal', 'vehiculo', 'flota'].includes(effective)) return;

    const movement = data.movementType === 'egreso' ? 'egreso' : 'ingreso';
    const dayKey = movement === 'egreso'
      ? `${effective}Egreso`
      : `${effective}Ingreso`;

    if (byDay[ymd][dayKey] != null) byDay[ymd][dayKey] += 1;
    totals[effective][movement] += 1;
  });

  const denialByPerson = new Map();
  const denialByDoor = new Map();

  accessEventDocs.forEach((doc) => {
    const data = typeof doc.data === 'function' ? doc.data() : doc;
    if (data.type !== 'denied') return;
    const ts = toJsDate(data.createdAt || data.timestamp);
    if (!ts) return;
    const ymd = getArgentinaDateString(ts);
    if (ymd < from || ymd > to) return;

    totals.denialsScanned += 1;

    const personKey = String(data.idNumber || '').trim() || String(data.name || '').trim() || 'sin-identificar';
    const personLabel = data.name
      ? `${data.name}${data.idNumber ? ` (${data.idNumber})` : ''}`
      : (data.idNumber || 'Sin identificar');
    const person = denialByPerson.get(personKey) || { key: personKey, label: personLabel, count: 0 };
    person.count += 1;
    if (data.name) person.label = personLabel;
    denialByPerson.set(personKey, person);

    const doorKey = String(data.doorId || data.doorName || '').trim() || 'sin-puerta';
    const doorLabel = data.doorName || data.doorId || 'Sin puerta';
    const door = denialByDoor.get(doorKey) || { key: doorKey, label: doorLabel, count: 0 };
    door.count += 1;
    denialByDoor.set(doorKey, door);
  });

  const topN = (map, n = 10) =>
    [...map.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, n);

  return {
    from,
    to,
    dailySeries: days.map((date) => ({ date, ...byDay[date] })),
    totals,
    topDenialsByPerson: topN(denialByPerson, 10),
    topDenialsByDoor: topN(denialByDoor, 10)
  };
};

const buildReportsSummary = async (db, { from, to } = {}) => {
  const fromYmd = String(from || '').trim();
  const toYmd = String(to || '').trim() || fromYmd;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(toYmd)) {
    const err = new Error('Parámetros from/to inválidos. Usá YYYY-MM-DD.');
    err.status = 400;
    throw err;
  }
  if (fromYmd > toYmd) {
    const err = new Error('La fecha desde no puede ser posterior a hasta.');
    err.status = 400;
    throw err;
  }
  if (daysBetween(fromYmd, toYmd) > MAX_RANGE_DAYS) {
    const err = new Error(`El rango máximo es de ${MAX_RANGE_DAYS} días.`);
    err.status = 400;
    throw err;
  }

  const startTs = parseYmdToStart(fromYmd);
  const endTs = parseYmdToEnd(toYmd);

  const [entryDocs, accessEventDocs] = await Promise.all([
    fetchAllInRange(db, 'entries', 'timestamp', startTs, endTs),
    fetchAllInRange(db, 'accessEvents', 'createdAt', startTs, endTs)
  ]);

  return aggregateReports({
    entryDocs,
    accessEventDocs,
    from: fromYmd,
    to: toYmd
  });
};

module.exports = {
  REPORTS_PERMISSION,
  MAX_RANGE_DAYS,
  aggregateReports,
  buildReportsSummary,
  eachYmdInRange,
  daysBetween
};
