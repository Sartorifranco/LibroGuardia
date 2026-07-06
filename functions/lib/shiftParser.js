const DAY_CODES = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do', 'Fe'];

const normalizeTime = (value) => {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
};

const parseShift = (turnoRaw = '') => {
  const raw = String(turnoRaw || '').trim();
  if (!raw || /^sin turno$/i.test(raw) || /^con citaci/i.test(raw)) {
    return { daysOfWeek: null, timeWindow: null, valid: false, raw };
  }

  const timeMatch = raw.match(/(\d{1,2}:\d{2})\s*a\s*(\d{1,2}:\d{2})/i);
  const timeWindow = timeMatch
    ? { from: normalizeTime(timeMatch[1]), to: normalizeTime(timeMatch[2]) }
    : null;

  const beforeTime = timeMatch ? raw.slice(0, timeMatch.index) : raw;
  const dayPart = beforeTime.replace(/\s/g, '');
  const days = DAY_CODES.filter((code) => dayPart.includes(code));

  return {
    daysOfWeek: days.length ? days : null,
    timeWindow,
    valid: Boolean(days.length || timeWindow),
    raw
  };
};

module.exports = {
  DAY_CODES,
  normalizeTime,
  parseShift
};
