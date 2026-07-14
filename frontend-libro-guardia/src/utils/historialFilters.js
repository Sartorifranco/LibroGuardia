import { entryMatchesTypeFilter } from './entryDisplay';

/** YYYY-MM-DD en zona local del navegador */
export const toLocalYmd = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const HISTORIAL_DATE_PRESETS = [
  { id: 'today', label: 'Hoy' },
  { id: '7d', label: 'Últimos 7 días' },
  { id: '30d', label: 'Último mes' },
  { id: 'custom', label: 'Rango personalizado' }
];

/**
 * Resuelve start/end (YYYY-MM-DD) según preset.
 * custom usa los valores ya elegidos por el usuario.
 */
export const resolveHistorialDateRange = (preset, customStart = '', customEnd = '', now = new Date()) => {
  const today = toLocalYmd(now);
  if (preset === 'today') {
    return { startDate: today, endDate: today };
  }
  if (preset === '7d') {
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    return { startDate: toLocalYmd(start), endDate: today };
  }
  if (preset === '30d') {
    const start = new Date(now);
    start.setDate(start.getDate() - 29);
    return { startDate: toLocalYmd(start), endDate: today };
  }
  return {
    startDate: customStart || '',
    endDate: customEnd || ''
  };
};

const parseEntryDate = (entry) => {
  const raw = entry?.timestamp || entry?.actualTime || entry?.eventTime;
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date;
};

/**
 * Filtro único para Historial (tabla + export).
 * @param {Array} entries
 * @param {{ startDate?: string, endDate?: string, typeFilter?: string, searchTerm?: string }} filters
 */
export const filterHistorialEntries = (entries = [], filters = {}) => {
  const {
    startDate = '',
    endDate = '',
    typeFilter = 'todos',
    searchTerm = ''
  } = filters;

  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  if (end) end.setHours(23, 59, 59, 999);

  const needle = String(searchTerm || '').trim().toLowerCase();

  return entries.filter((entry) => {
    const entryDate = parseEntryDate(entry);
    const matchesDate = (
      (!start || (entryDate && entryDate >= start))
      && (!end || (entryDate && entryDate <= end))
    );
    const matchesType = entryMatchesTypeFilter(entry, typeFilter);
    const matchesSearch = !needle || Object.values(entry || {}).some((value) => (
      String(value ?? '').toLowerCase().includes(needle)
    ));
    return matchesDate && matchesType && matchesSearch;
  });
};
