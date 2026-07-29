/**
 * Espejo liviano de functions/lib/shiftParser.js para feedback en Admin → Nómina.
 * Debe mantenerse alineado con el parser del backend.
 */
const DAY_CODES = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do', 'Fe'];

const normalizeTime = (value) => {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
};

export const parseTurnoPreview = (turnoRaw = '') => {
  const raw = String(turnoRaw || '').trim();
  if (!raw) {
    return { valid: false, empty: true, label: 'Sin turno cargado' };
  }
  if (/^sin turno$/i.test(raw) || /^con citaci/i.test(raw)) {
    return { valid: false, empty: false, label: 'Sin horario fijo (no restringe por turno)' };
  }

  const timeMatch = raw.match(/(\d{1,2}:\d{2})\s*a\s*(\d{1,2}:\d{2})/i);
  const timeWindow = timeMatch
    ? { from: normalizeTime(timeMatch[1]), to: normalizeTime(timeMatch[2]) }
    : null;

  const beforeTime = timeMatch ? raw.slice(0, timeMatch.index) : raw;
  const dayPart = beforeTime.replace(/\s/g, '');
  const days = DAY_CODES.filter((code) => dayPart.includes(code));

  const valid = Boolean(days.length || timeWindow);
  if (!valid) {
    return {
      valid: false,
      empty: false,
      label: 'No se pudo interpretar. Usá días Lu,Ma,Mi… y horario HH:MM a HH:MM'
    };
  }

  const parts = [];
  if (days.length) parts.push(days.join(', '));
  if (timeWindow?.from && timeWindow?.to) parts.push(`${timeWindow.from}–${timeWindow.to}`);

  return {
    valid: true,
    empty: false,
    daysOfWeek: days.length ? days : null,
    timeWindow,
    label: parts.join(' · ')
  };
};
