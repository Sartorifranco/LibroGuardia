const { isWithinTimeWindow } = require('./normalize');

const TOLERANCIA_MINUTOS = 15;
const STRICT_TIME_WINDOW_CITACION = false;

const AUTH_PRIORITY = {
  permanent: 3,
  citacion: 2,
  visita: 1,
  visit: 1,
  temporal: 1
};

const RANGE_AUTH_TYPES = new Set(['visita', 'visit', 'temporal']);

const isPermanentValid = (auth, dayCode, referenceDate = new Date()) => {
  if (Array.isArray(auth.daysOfWeek) && auth.daysOfWeek.length > 0) {
    if (!auth.daysOfWeek.includes(dayCode)) return false;
  }

  if (auth.timeWindow && !isWithinTimeWindow(auth.timeWindow, TOLERANCIA_MINUTOS, referenceDate)) {
    return false;
  }

  return true;
};

const isCitacionValid = (auth, today, referenceDate = new Date()) => {
  const appointmentDate = auth.appointmentDate || auth.startDate;
  if (appointmentDate !== today) return false;

  if (auth.timeWindow && !isWithinTimeWindow(auth.timeWindow, TOLERANCIA_MINUTOS, referenceDate)) {
    if (STRICT_TIME_WINDOW_CITACION) return false;
    console.warn('[accessControl] Citación fuera de horario (no bloqueada)', {
      appointmentDate,
      timeWindow: auth.timeWindow
    });
  }

  return true;
};

const isRangeAuthValid = (auth, today) => {
  const startDate = auth.startDate;
  const endDate = auth.endDate || auth.startDate;
  if (!startDate) return false;
  return today >= startDate && today <= endDate;
};

const pickBestAuthorization = (candidates = []) => {
  if (!candidates.length) return null;

  return candidates.sort((a, b) => {
    const priorityDiff = (AUTH_PRIORITY[b.type] || 0) - (AUTH_PRIORITY[a.type] || 0);
    if (priorityDiff !== 0) return priorityDiff;
    return String(a.id).localeCompare(String(b.id));
  })[0];
};

const evaluateAuthorizationCandidates = ({
  permanentDocs = [],
  citacionDocs = [],
  rangeDocs = [],
  today,
  dayCode,
  referenceDate = new Date()
}) => {
  const validPermanent = permanentDocs
    .filter((auth) => isPermanentValid(auth, dayCode, referenceDate));

  if (validPermanent.length) {
    return { authorization: pickBestAuthorization(validPermanent), denialReason: null };
  }

  const validCitacion = citacionDocs
    .filter((auth) => isCitacionValid(auth, today, referenceDate));

  if (validCitacion.length) {
    return { authorization: pickBestAuthorization(validCitacion), denialReason: null };
  }

  const validRange = rangeDocs
    .filter((auth) => RANGE_AUTH_TYPES.has(auth.type) && isRangeAuthValid(auth, today));

  if (validRange.length) {
    return { authorization: pickBestAuthorization(validRange), denialReason: null };
  }

  return { authorization: null, denialReason: 'sin_citacion_para_hoy' };
};

module.exports = {
  TOLERANCIA_MINUTOS,
  STRICT_TIME_WINDOW_CITACION,
  AUTH_PRIORITY,
  isPermanentValid,
  isCitacionValid,
  isRangeAuthValid,
  pickBestAuthorization,
  evaluateAuthorizationCandidates
};
