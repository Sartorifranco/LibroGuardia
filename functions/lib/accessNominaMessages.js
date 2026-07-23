const { db } = require('../firestore');
const { getArgentinaDateParts, isWithinShiftAccessWindow } = require('./normalize');
const { normalizeIdNumber } = require('../dniParser');
const {
  evaluateExpectedToday,
  loadCitacionesToday,
  normalizeLegajo
} = require('../attendanceAlerts');
const { isCitacionRequiredArea, isSistemasArea } = require('./centroCostoGroups');
const { resolveShiftSchedule } = require('./shiftParser');
const { hydrateAuthorizationForRead } = require('./transportCsvParser');
const { mark: profileMark } = require('./kioskProfile');

const SHIFT_EARLY_MINUTES = 30;
const SHIFT_LATE_MINUTES = 15;

let citacionesTodayCache = { date: null, data: null, at: 0 };
const CITACIONES_CACHE_MS = 45_000;

/** Caché de próxima citación por persona (mismo TTL que citaciones de hoy). */
const nextCitacionCache = new Map();

const getCitacionesTodayCached = async (dateString) => {
  const now = Date.now();
  if (
    citacionesTodayCache.date === dateString
    && citacionesTodayCache.data
    && now - citacionesTodayCache.at < CITACIONES_CACHE_MS
  ) {
    profileMark('nomina.loadCitacionesToday.cacheHit');
    return citacionesTodayCache.data;
  }
  const data = await loadCitacionesToday(dateString);
  citacionesTodayCache = { date: dateString, data, at: now };
  profileMark('nomina.loadCitacionesToday');
  return data;
};

const DAY_LABELS = {
  Lu: 'lunes',
  Ma: 'martes',
  Mi: 'miércoles',
  Ju: 'jueves',
  Vi: 'viernes',
  Sa: 'sábado',
  Do: 'domingo'
};

const findPersonalMaster = async ({ personId, dniNormalized, legajoNormalized }) => {
  if (personId) {
    const snap = await db.collection('personalMaster')
      .where('personId', '==', personId)
      .where('source', '==', 'nomina')
      .limit(1)
      .get();
    if (!snap.empty) {
      profileMark('nomina.findPersonalMaster.byPersonId');
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }
  }

  if (dniNormalized) {
    const snap = await db.collection('personalMaster')
      .where('idNumberNormalized', '==', dniNormalized)
      .where('source', '==', 'nomina')
      .limit(1)
      .get();
    if (!snap.empty) {
      profileMark('nomina.findPersonalMaster.byDni');
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }
  }

  if (legajoNormalized) {
    const snap = await db.collection('personalMaster')
      .where('legajoNormalized', '==', legajoNormalized)
      .where('source', '==', 'nomina')
      .limit(1)
      .get();
    if (!snap.empty) {
      profileMark('nomina.findPersonalMaster.byLegajo');
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }
  }

  profileMark('nomina.findPersonalMaster.miss');
  return null;
};

const findNextCitacionDate = async (employee, afterDate) => {
  const dni = employee.idNumberNormalized || normalizeIdNumber(employee.idNumber);
  const legajo = normalizeLegajo(employee.legajoNormalized || employee.legajo);
  const cacheKey = `${legajo || ''}|${dni || ''}|${afterDate}`;
  const cached = nextCitacionCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < CITACIONES_CACHE_MS) {
    profileMark('nomina.findNextCitacionDate.cacheHit');
    return cached.value;
  }

  const snap = await db.collection('authorizations')
    .where('active', '==', true)
    .where('type', '==', 'citacion')
    .get();
  profileMark('nomina.findNextCitacionDate');

  const future = snap.docs
    .map((doc) => hydrateAuthorizationForRead({ id: doc.id, ...doc.data() }))
    .filter((item) => {
      const date = item.appointmentDate || item.startDate;
      if (!date || date <= afterDate) return false;
      const itemDni = item.idNumberNormalized || normalizeIdNumber(item.idNumber);
      const itemLegajo = normalizeLegajo(item.legajoNormalized || item.legajo);
      if (dni && itemDni && dni === itemDni) return true;
      if (legajo && itemLegajo && legajo === itemLegajo) return true;
      return false;
    })
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

  const value = future[0] || null;
  nextCitacionCache.set(cacheKey, { at: now, value });
  return value;
};

const formatShiftDays = (shift) => {
  if (!shift?.daysOfWeek?.length) return '';
  return shift.daysOfWeek.map((code) => DAY_LABELS[code] || code).join(', ');
};

const resolveAccessTimeWindow = (employee, citacionesToday, shift) => {
  const centro = employee.centroCosto || employee.company || '';
  if (isCitacionRequiredArea(centro)) {
    const dni = employee.idNumberNormalized || normalizeIdNumber(employee.idNumber);
    const legajo = normalizeLegajo(employee.legajoNormalized || employee.legajo);
    const citacion = citacionesToday.find((item) => {
      const itemDni = item.idNumberNormalized || normalizeIdNumber(item.idNumber);
      const itemLegajo = normalizeLegajo(item.legajoNormalized || item.legajo);
      if (dni && itemDni && dni === itemDni) return true;
      if (legajo && itemLegajo && legajo === itemLegajo) return true;
      return false;
    });
    if (citacion?.timeWindow?.from && citacion?.timeWindow?.to) {
      return citacion.timeWindow;
    }
    if (citacion?.appointmentTime) {
      const to = shift?.timeWindow?.to || citacion.appointmentTime;
      return { from: citacion.appointmentTime, to };
    }
  }
  return shift?.timeWindow || null;
};

const checkShiftTimeAccess = (timeWindow, referenceDate, timeString) => {
  if (!timeWindow?.from || !timeWindow?.to) return { allowed: true };

  const within = isWithinShiftAccessWindow(timeWindow, referenceDate, {
    earlyMinutes: SHIFT_EARLY_MINUTES,
    lateMinutes: SHIFT_LATE_MINUTES
  });

  if (within) return { allowed: true };

  return {
    allowed: false,
    message: `fuera de horario (${timeWindow.from}–${timeWindow.to}, tolerancia ${SHIFT_EARLY_MINUTES} min antes / ${SHIFT_LATE_MINUTES} min después). Hora actual: ${timeString}.`,
    reason: 'fuera_horario_turno'
  };
};

/**
 * Prefetch independiente: personalMaster + citaciones de hoy (en paralelo).
 * Usado por processKioskScan para solapar con validarAcceso.
 */
const prefetchNominaAccessData = async ({
  personId = null,
  dniNormalized = '',
  referenceDate = new Date()
} = {}) => {
  const { dateString } = getArgentinaDateParts(referenceDate);
  const [employee, citacionesToday] = await Promise.all([
    findPersonalMaster({ personId, dniNormalized }),
    getCitacionesTodayCached(dateString)
  ]);
  profileMark('nomina.prefetchParallel');
  return { employee, citacionesToday, dateString };
};

const buildNominaAccessMessage = async ({
  personId,
  dniNormalized,
  personName = '',
  referenceDate = new Date(),
  prefetched = null
}) => {
  const employee = prefetched && Object.prototype.hasOwnProperty.call(prefetched, 'employee')
    ? prefetched.employee
    : await findPersonalMaster({ personId, dniNormalized });
  if (!employee || employee.active === false) return null;

  const { dateString, dayCode, timeString } = getArgentinaDateParts(referenceDate);
  const citacionesToday = prefetched?.citacionesToday
    || await getCitacionesTodayCached(dateString);
  const shift = resolveShiftSchedule(employee);
  const name = personName || employee.name || 'Esta persona';
  const centro = employee.centroCosto || employee.company || '';

  if (isSistemasArea(centro)) {
    return {
      authorized: true,
      message: `${name} — Sistemas: ingreso autorizado (acceso permanente a planta).`,
      reason: 'sistemas_acceso_permanente'
    };
  }

  const evaluation = evaluateExpectedToday(employee, { dayCode, citacionesToday });
  const timeWindow = resolveAccessTimeWindow(employee, citacionesToday, shift);

  if (evaluation.expected) {
    const timeCheck = checkShiftTimeAccess(timeWindow, referenceDate, timeString);
    if (!timeCheck.allowed) {
      return {
        authorized: false,
        message: `${name} tiene turno/citación hoy pero ${timeCheck.message}`,
        reason: timeCheck.reason
      };
    }

    const hora = evaluation.entryTime || timeWindow?.from || '';
    if (isCitacionRequiredArea(centro)) {
      return {
        authorized: true,
        message: `${name} está citado hoy${hora ? ` (${hora})` : ''}. Ingreso autorizado.`,
        reason: 'citacion_hoy'
      };
    }

    return {
      authorized: true,
      message: `${name} corresponde ingreso hoy según turno${hora ? ` (${hora})` : ''}. Ingreso autorizado.`,
      reason: 'turno_hoy'
    };
  }

  // Solo en denegación por falta de citación hoy (mensaje informativo).
  if (evaluation.reason === 'sin_citacion_hoy' && isCitacionRequiredArea(centro)) {
    const next = await findNextCitacionDate(employee, dateString);
    const nextLabel = next
      ? `${next.startDate}${next.timeWindow?.from ? ` a las ${next.timeWindow.from}` : ''}`
      : 'sin citación programada';
    return {
      authorized: false,
      message: `${name} no está citado el día de hoy. Próximo ingreso previsto: ${nextLabel}.`,
      reason: 'sin_citacion_hoy'
    };
  }

  if (evaluation.reason === 'fuera_dia_turno') {
    const days = formatShiftDays(shift);
    return {
      authorized: false,
      message: `${name} no corresponde ingreso hoy. Turno: ${employee.turnoRaw || days || 'sin turno cargado'}.`,
      reason: 'fuera_dia_turno'
    };
  }

  if (evaluation.reason === 'sin_turno') {
    return {
      authorized: false,
      message: `${name} está en nómina pero no tiene turno cargado. Consulte con administración.`,
      reason: 'sin_turno'
    };
  }

  return null;
};

module.exports = {
  buildNominaAccessMessage,
  prefetchNominaAccessData,
  findPersonalMaster,
  SHIFT_EARLY_MINUTES,
  SHIFT_LATE_MINUTES
};
