const { db, FieldValue } = require('./firestore');
const { getArgentinaDateParts, timeToMinutes } = require('./lib/normalize');
const { normalizeIdNumber } = require('./dniParser');
const { buildNameTokens } = require('./authorizations');
const { extractAreaShort, getAreaKey, buildAttendanceAreaSummary } = require('./lib/centroCostoGroups');

const DEFAULT_TOLERANCE_MINUTES = 30;
const DISMISSALS_COLLECTION = 'attendanceDismissals';

const normalizeLegajo = (value = '') => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits) return String(Number.parseInt(digits, 10));
  return raw.toLowerCase();
};

const normalizeNameKey = (name = '') => buildNameTokens(name);

const getTodayBounds = (dateString) => ({
  start: `${dateString}T00:00:00-03:00`,
  end: `${dateString}T23:59:59-03:00`
});

const loadTodayEntries = async (dateString) => {
  const snap = await db.collection('entries')
    .orderBy('timestamp', 'desc')
    .limit(800)
    .get();

  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((entry) => {
      if (entry.type !== 'personal' || entry.movementType !== 'ingreso') return false;
      const ts = entry.timestamp?.toDate?.() || new Date(entry.timestamp);
      if (Number.isNaN(ts.getTime())) return false;
      return getArgentinaDateParts(ts).dateString === dateString;
    });
};

const loadCitacionesToday = async (dateString) => {
  const snap = await db.collection('authorizations')
    .where('active', '==', true)
    .where('type', '==', 'citacion')
    .get();

  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => (item.appointmentDate || item.startDate) === dateString);
};

const loadDismissalsToday = async (dateString) => {
  const snap = await db.collection(DISMISSALS_COLLECTION)
    .where('date', '==', dateString)
    .get();
  const set = new Set();
  snap.docs.forEach((doc) => {
    const data = doc.data();
    if (data.personId) set.add(data.personId);
    if (data.legajoNormalized) set.add(`legajo:${normalizeLegajo(data.legajoNormalized)}`);
    if (data.idNumberNormalized) set.add(`dni:${data.idNumberNormalized}`);
  });
  return set;
};

const hasIngresoToday = (employee, entries) => {
  const dni = employee.idNumberNormalized || normalizeIdNumber(employee.idNumber);
  const legajo = normalizeLegajo(employee.legajoNormalized || employee.legajo);
  const nameKey = employee.nameKey || normalizeNameKey(employee.name);

  return entries.some((entry) => {
    const entryDni = normalizeIdNumber(entry.idNumber);
    const entryLegajo = normalizeLegajo(entry.legajo || entry.legajoNormalized);
    if (dni && entryDni && entryDni === dni) return true;
    if (legajo && entryLegajo && entryLegajo === legajo) return true;
    if (legajo && normalizeLegajo(entry.idNumber) === legajo) return true;
    if (nameKey && normalizeNameKey(entry.name) === nameKey) return true;
    return false;
  });
};

const hasCitacionToday = (employee, citaciones) => {
  const dni = employee.idNumberNormalized || normalizeIdNumber(employee.idNumber);
  const legajo = normalizeLegajo(employee.legajoNormalized || employee.legajo);
  const nameKey = employee.nameKey || normalizeNameKey(employee.name);

  return citaciones.some((item) => {
    const itemDni = item.idNumberNormalized || normalizeIdNumber(item.idNumber);
    const itemLegajo = normalizeLegajo(item.legajoNormalized || item.legajo);
    if (dni && itemDni && itemDni === dni) return true;
    if (legajo && itemLegajo && itemLegajo === legajo) return true;
    if (nameKey && item.nameKey === nameKey) return true;
    if (nameKey && normalizeNameKey(item.name) === nameKey) return true;
    return false;
  });
};

const employeeRequiresCitacion = (employee) => {
  if (employee.requiresCitacion === true) return true;
  const raw = String(employee.conCitacionRaw || '').trim().toUpperCase();
  return raw === 'SI' || raw === 'SÍ';
};

const evaluateExpectedToday = (employee, { dayCode, citacionesToday }) => {
  if (employee.active === false) {
    return { expected: false, reason: 'inactivo' };
  }

  const shift = employee.shiftSchedule;
  const requiresCitacion = employeeRequiresCitacion(employee);
  const policy = employee.authorizationPolicy || 'unknown';

  if (hasCitacionToday(employee, citacionesToday)) {
    if (shift?.daysOfWeek?.length && !shift.daysOfWeek.includes(dayCode)) {
      return { expected: false, reason: 'fuera_dia_turno' };
    }
    return {
      expected: true,
      entryTime: shift?.timeWindow?.from || '07:00',
      reason: 'citacion_hoy'
    };
  }

  if (requiresCitacion) {
    return { expected: false, reason: 'sin_citacion_hoy' };
  }

  if (policy === 'permanent_shift' || (shift?.daysOfWeek?.length && policy === 'permanent')) {
    if (!shift?.daysOfWeek?.includes(dayCode)) {
      return { expected: false, reason: 'fuera_dia_turno' };
    }
    return {
      expected: true,
      entryTime: shift?.timeWindow?.from || '07:00',
      reason: 'turno_hoy'
    };
  }

  if (policy === 'permanent' && shift?.daysOfWeek?.length) {
    if (!shift.daysOfWeek.includes(dayCode)) {
      return { expected: false, reason: 'fuera_dia_turno' };
    }
    return {
      expected: true,
      entryTime: shift?.timeWindow?.from || '07:00',
      reason: 'permanente_turno'
    };
  }

  return { expected: false, reason: 'sin_turno_o_politica' };
};

const isPastEntryDeadline = (entryTime, toleranceMinutes, referenceDate) => {
  const { timeString } = getArgentinaDateParts(referenceDate);
  const nowMinutes = timeToMinutes(timeString);
  const entryMinutes = timeToMinutes(entryTime || '07:00');
  if (nowMinutes === null || entryMinutes === null) return false;
  return nowMinutes >= entryMinutes + toleranceMinutes;
};

const isDismissedToday = (employee, dismissals) =>
  dismissals.has(employee.personId)
  || dismissals.has(`legajo:${normalizeLegajo(employee.legajoNormalized || employee.legajo)}`)
  || dismissals.has(`dni:${employee.idNumberNormalized || normalizeIdNumber(employee.idNumber)}`);

const buildRosterItem = (employee, evaluation, status) => {
  const centroCosto = employee.centroCosto || employee.company || '';
  return {
    personId: employee.personId || null,
    personalMasterId: employee.id,
    name: employee.name,
    legajo: employee.legajoNormalized || employee.legajo || '',
    idNumber: employee.idNumberNormalized || employee.idNumber || '',
    role: employee.role || '',
    centroCosto,
    areaShort: extractAreaShort(centroCosto),
    areaKey: getAreaKey(centroCosto),
    turnoRaw: employee.turnoRaw || '',
    entryTime: evaluation.entryTime,
    reason: evaluation.reason,
    requiresCitacion: employeeRequiresCitacion(employee),
    authorizationPolicy: employee.authorizationPolicy || '',
    status
  };
};

const getMissingAttendanceAlerts = async (options = {}) => {
  const referenceDate = options.referenceDate || new Date();
  const { dateString, dayCode, timeString } = getArgentinaDateParts(referenceDate);
  const toleranceMinutes = Number(options.toleranceMinutes) || DEFAULT_TOLERANCE_MINUTES;

  const [personalSnap, entries, citacionesToday, dismissals] = await Promise.all([
    db.collection('personalMaster').where('source', '==', 'nomina').get(),
    loadTodayEntries(dateString),
    loadCitacionesToday(dateString),
    loadDismissalsToday(dateString)
  ]);

  const employees = personalSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((employee) => employee.active !== false);

  const roster = [];
  const missing = [];
  let expectedCount = 0;
  let presentCount = 0;
  let absentCount = 0;
  let pendingCount = 0;

  employees.forEach((employee) => {
    const evaluation = evaluateExpectedToday(employee, { dayCode, citacionesToday });
    if (!evaluation.expected) return;

    expectedCount += 1;
    const ingreso = hasIngresoToday(employee, entries);
    const dismissed = isDismissedToday(employee, dismissals);

    let status;
    if (ingreso) {
      status = 'present';
      presentCount += 1;
    } else if (dismissed) {
      status = 'absent';
      absentCount += 1;
    } else if (!isPastEntryDeadline(evaluation.entryTime, toleranceMinutes, referenceDate)) {
      status = 'pending';
      pendingCount += 1;
    } else {
      status = 'missing';
    }

    const item = buildRosterItem(employee, evaluation, status);
    roster.push(item);
    if (status === 'missing') missing.push(item);
  });

  roster.sort((a, b) => {
    const order = { missing: 0, pending: 1, absent: 2, present: 3 };
    const diff = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (diff !== 0) return diff;
    return (a.name || '').localeCompare(b.name || '');
  });

  missing.sort((a, b) => (a.entryTime || '').localeCompare(b.entryTime || '') || (a.name || '').localeCompare(b.name || ''));

  const areas = buildAttendanceAreaSummary(employees, roster);

  return {
    date: dateString,
    time: timeString,
    dayCode,
    toleranceMinutes,
    nominaTotal: employees.length,
    expectedCount,
    presentCount,
    absentCount,
    pendingCount,
    missingCount: missing.length,
    roster,
    areas,
    missing,
    citacionesHoy: citacionesToday.length,
    message: missing.length
      ? `${missing.length} persona(s) sin ingreso marcado`
      : expectedCount > 0
        ? `Sin faltantes (${presentCount}/${expectedCount} presentes)`
        : `Sin personal esperado hoy (${employees.length} en nómina · ${citacionesToday.length} citaciones)`
  };
};

const bulkDismissAttendance = async (items = [], { guardId, reason = 'ausente_guardia' } = {}, referenceDate = new Date()) => {
  const { dateString } = getArgentinaDateParts(referenceDate);
  const batch = db.batch();
  let count = 0;

  items.forEach((item) => {
    const ref = db.collection(DISMISSALS_COLLECTION).doc();
    batch.set(ref, {
      date: dateString,
      personId: item.personId || null,
      legajoNormalized: item.legajo || item.legajoNormalized || null,
      idNumberNormalized: item.idNumber || item.idNumberNormalized || null,
      name: item.name || '',
      reason,
      dismissedBy: guardId || null,
      dismissedAt: FieldValue.serverTimestamp()
    });
    count += 1;
  });

  if (count > 0) await batch.commit();
  return { message: `${count} marcado(s) como ausente`, count };
};

const dismissAttendanceAlert = async ({
  personId,
  legajoNormalized,
  idNumberNormalized,
  name,
  reason,
  guardId
}, referenceDate = new Date()) => {
  const { dateString } = getArgentinaDateParts(referenceDate);
  await db.collection(DISMISSALS_COLLECTION).add({
    date: dateString,
    personId: personId || null,
    legajoNormalized: legajoNormalized || null,
    idNumberNormalized: idNumberNormalized || null,
    name: name || '',
    reason: reason || 'omitido',
    dismissedBy: guardId || null,
    dismissedAt: FieldValue.serverTimestamp()
  });
  return { message: 'Alerta omitida para hoy' };
};

module.exports = {
  DEFAULT_TOLERANCE_MINUTES,
  getMissingAttendanceAlerts,
  dismissAttendanceAlert,
  bulkDismissAttendance,
  evaluateExpectedToday,
  hasIngresoToday
};
