const { db } = require('./firestore');
const { getArgentinaDateParts } = require('./lib/normalize');
const { buildNominaEmployeeIndex, matchCitacionToEmployee, normalizeLegajo } = require('./lib/personMatch');
const { buildNameTokens } = require('./lib/nameUtils');
const { applyTransportParseToCitacion } = require('./lib/transportCsvParser');
const {
  extractAreaShort,
  getAreaKey,
  buildAreaGroups
} = require('./lib/centroCostoGroups');
const { resolveShiftSchedule } = require('./lib/shiftParser');
const {
  DEFAULT_TOLERANCE_MINUTES,
  loadTodayEntries,
  loadCitacionesToday,
  loadDismissalsToday,
  hasIngresoToday,
  isDismissedToday,
  isPastEntryDeadline
} = require('./attendanceAlerts');

const buildCitadoItem = (citacion, employee, evaluation, status) => {
  const centroCosto = employee?.centroCosto || employee?.company || citacion.destination || citacion.company || '';
  const nominaMatched = Boolean(employee?.id);

  return {
    citacionId: citacion.id,
    personId: employee?.personId || citacion.personId || null,
    personalMasterId: employee?.id || null,
    nominaMatched,
    name: employee?.name || citacion.name || '',
    legajo: employee?.legajoNormalized || employee?.legajo || citacion.legajoNormalized || citacion.legajo || '',
    idNumber: employee?.idNumberNormalized || employee?.idNumber || citacion.idNumberNormalized || citacion.idNumber || '',
    role: employee?.role || citacion.role || '',
    centroCosto,
    areaShort: extractAreaShort(centroCosto || citacion.destination || citacion.company || ''),
    areaKey: getAreaKey(centroCosto || citacion.destination || citacion.company || ''),
    company: citacion.company || employee?.company || '',
    destination: citacion.destination || '',
    turnoRaw: employee?.turnoRaw || '',
    entryTime: evaluation.entryTime,
    appointmentTime: citacion.timeWindow?.from || citacion.appointmentTime || evaluation.entryTime,
    reason: evaluation.reason,
    status
  };
};

const citacionPersonStub = (citacion = {}) => ({
  personId: citacion.personId || null,
  legajoNormalized: citacion.legajoNormalized || normalizeLegajo(citacion.legajo),
  legajo: citacion.legajo || citacion.legajoNormalized || '',
  idNumberNormalized: citacion.idNumberNormalized || citacion.idNumber || '',
  idNumber: citacion.idNumber || citacion.idNumberNormalized || '',
  name: citacion.name || '',
  nameKey: citacion.nameKey || citacion.nameTokens || buildNameTokens(citacion.name)
});

const evaluateCitacionOnly = (citacion = {}) => {
  const horaFromNotes = citacion.notes?.match(/hora ingreso:\s*(\d{1,2}:\d{2})/i)?.[1];
  const entryTime = citacion.timeWindow?.from
    || citacion.appointmentTime
    || horaFromNotes
    || '07:00';

  return { expected: true, entryTime, reason: 'citacion_hoy' };
};

const evaluateCitadoExpected = (citacion, employee, { dayCode }) => {
  const shift = resolveShiftSchedule(employee);
  const entryTime = citacion.timeWindow?.from
    || shift?.timeWindow?.from
    || '07:00';

  if (shift?.daysOfWeek?.length && !shift.daysOfWeek.includes(dayCode)) {
    return { expected: false, entryTime, reason: 'fuera_dia_turno' };
  }

  return { expected: true, entryTime, reason: 'citacion_hoy' };
};

const buildCitadosAreaSummary = (roster = []) => {
  const groups = buildAreaGroups(
    roster.map((item) => ({ centroCosto: item.centroCosto || item.destination || item.company || '' }))
  );

  const stats = new Map();
  roster.forEach((item) => {
    const key = item.areaKey || getAreaKey(item.centroCosto);
    const bucket = stats.get(key) || { expectedToday: 0, presentToday: 0, missingToday: 0 };
    bucket.expectedToday += 1;
    if (item.status === 'present') bucket.presentToday += 1;
    if (item.status === 'missing') bucket.missingToday += 1;
    stats.set(key, bucket);
  });

  return groups
    .map((group) => {
      const bucket = stats.get(group.key) || { expectedToday: 0, presentToday: 0, missingToday: 0 };
      return {
        key: group.key,
        label: group.label,
        totalCitados: bucket.expectedToday,
        expectedToday: bucket.expectedToday,
        presentToday: bucket.presentToday,
        missingToday: bucket.missingToday
      };
    })
    .filter((area) => area.expectedToday > 0)
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));
};

const getCitadosToday = async (options = {}) => {
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

  const index = buildNominaEmployeeIndex(employees);
  const roster = [];
  const missing = [];
  let presentCount = 0;
  let absentCount = 0;
  let pendingCount = 0;
  let matchedNomina = 0;
  let unmatched = 0;

  citacionesToday.forEach((rawCitacion) => {
    const citacion = applyTransportParseToCitacion(rawCitacion);
    const employee = matchCitacionToEmployee(citacion, index);
    const personRef = employee || citacionPersonStub(citacion);
    const evaluation = employee
      ? evaluateCitadoExpected(citacion, employee, { dayCode })
      : evaluateCitacionOnly(citacion);

    if (employee) {
      matchedNomina += 1;
    } else {
      unmatched += 1;
    }

    if (!evaluation.expected) return;

    const ingreso = hasIngresoToday(personRef, entries);
    const dismissed = isDismissedToday(personRef, dismissals);

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

    const item = buildCitadoItem(citacion, employee, evaluation, status);
    roster.push(item);
    if (status === 'missing') missing.push(item);
  });

  roster.sort((a, b) => {
    const order = { missing: 0, pending: 1, absent: 2, present: 3 };
    const diff = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (diff !== 0) return diff;
    return (a.name || '').localeCompare(b.name || '');
  });

  const areas = buildCitadosAreaSummary(roster);
  const expectedCount = roster.length;

  return {
    date: dateString,
    time: timeString,
    dayCode,
    toleranceMinutes,
    expectedCount,
    presentCount,
    absentCount,
    pendingCount,
    missingCount: missing.length,
    citacionesTotal: citacionesToday.length,
    matchedNomina,
    unmatchedCitaciones: unmatched,
    roster,
    areas,
    missing,
    message: missing.length
      ? `${missing.length} citado(s) sin registro de ingreso`
      : expectedCount > 0
        ? `${presentCount}/${expectedCount} en planta${unmatched ? ` (${unmatched} sin match en nómina)` : ''}`
        : citacionesToday.length > 0
          ? `${citacionesToday.length} citado(s) en planilla`
          : 'Sin citaciones para hoy'
  };
};

module.exports = {
  getCitadosToday
};
