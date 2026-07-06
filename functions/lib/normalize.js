const stripAccents = (value = '') =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const normalizeDni = (dni = '') =>
  String(dni || '').replace(/\D/g, '');

const normalizeLegajo = (legajo = '') =>
  String(legajo || '').trim();

const buildNameKey = (nombre = '', apellido = '') => {
  const combined = [nombre, apellido]
    .map((part) => stripAccents(part).trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  return combined
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .sort()
    .join(' ');
};

const buildFullName = (nombre = '', apellido = '') =>
  [nombre, apellido].map((part) => String(part || '').trim()).filter(Boolean).join(' ');

const getArgentinaDateParts = (referenceDate = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(referenceDate).map((part) => [part.type, part.value])
  );

  const weekdayMap = {
    Sun: 'Do',
    Mon: 'Lu',
    Tue: 'Ma',
    Wed: 'Mi',
    Thu: 'Ju',
    Fri: 'Vi',
    Sat: 'Sa'
  };

  return {
    dateString: `${parts.year}-${parts.month}-${parts.day}`,
    timeString: `${parts.hour.padStart(2, '0')}:${parts.minute.padStart(2, '0')}`,
    dayCode: weekdayMap[parts.weekday] || 'Lu'
  };
};

const getArgentinaDateString = (referenceDate = new Date()) =>
  getArgentinaDateParts(referenceDate).dateString;

const timeToMinutes = (hhmm = '') => {
  const [hours, minutes] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

const isWithinTimeWindow = (timeWindow, toleranceMinutes = 0, referenceDate = new Date()) => {
  if (!timeWindow?.from || !timeWindow?.to) return true;

  const { timeString } = getArgentinaDateParts(referenceDate);
  const nowMinutes = timeToMinutes(timeString);
  const fromMinutes = timeToMinutes(timeWindow.from);
  const toMinutes = timeToMinutes(timeWindow.to);

  if (nowMinutes === null || fromMinutes === null || toMinutes === null) return true;

  return nowMinutes >= (fromMinutes - toleranceMinutes)
    && nowMinutes <= (toMinutes + toleranceMinutes);
};

module.exports = {
  stripAccents,
  normalizeDni,
  normalizeLegajo,
  buildNameKey,
  buildFullName,
  getArgentinaDateParts,
  getArgentinaDateString,
  timeToMinutes,
  isWithinTimeWindow
};
