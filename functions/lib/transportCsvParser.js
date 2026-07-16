const { buildNameTokens } = require('./nameUtils');
const { normalizeLegajo } = require('./personMatch');

const SPANISH_MONTHS = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12'
};

const parseTransportDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);

  const spanishMatch = trimmed.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{4})$/);
  if (spanishMatch) {
    const month = SPANISH_MONTHS[spanishMatch[2].toLowerCase().slice(0, 3)];
    if (month) {
      return `${spanishMatch[3]}-${month}-${spanishMatch[1].padStart(2, '0')}`;
    }
  }

  const parts = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (parts) {
    const day = parts[1].padStart(2, '0');
    const month = parts[2].padStart(2, '0');
    let year = parts[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }

  return null;
};

const TRANSPORT_CSV_LINE = /^\d{3,5},/;

const parseCsvFields = (line = '') => {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  fields.push(current.trim());
  return fields.map((field) => field.replace(/^"|"$/g, '').trim());
};

const militaryTimeToHHMM = (value) => {
  if (value === null || value === undefined || value === '') return null;

  const raw = String(value).trim();
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [hours, minutes] = raw.split(':');
    return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  const hours = Math.floor(n / 100);
  const minutes = n % 100;
  if (hours > 23 || minutes > 59) return null;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const looksLikeTransportCsvLine = (value = '') => {
  const line = String(value).replace(/^Legajo\s+/i, '').trim();
  if (!TRANSPORT_CSV_LINE.test(line)) return false;
  const fields = parseCsvFields(line);
  return fields.length >= 5 && Boolean(fields[1]);
};

const parseTransportCsvLine = (line = '') => {
  const cleaned = String(line).replace(/^Legajo\s+/i, '').trim();
  if (!looksLikeTransportCsvLine(cleaned)) return null;

  const fields = parseCsvFields(cleaned);
  const [
    legajoRaw,
    name,
    centroCosto,
    puesto,
    fechaRaw,
    horaRaw
  ] = fields;

  const legajo = String(legajoRaw || '').replace(/\D/g, '') || legajoRaw;
  const startDate = parseTransportDate(fechaRaw);
  const appointmentTime = militaryTimeToHHMM(horaRaw);

  return {
    legajo,
    name: String(name || '').trim(),
    centroCosto: String(centroCosto || '').trim(),
    destination: String(centroCosto || '').trim(),
    role: String(puesto || '').trim(),
    company: String(centroCosto || '').trim(),
    startDate,
    appointmentTime,
    horaRaw: horaRaw != null ? String(horaRaw) : ''
  };
};

const extractTransportCsvLine = (rawRow = {}) => {
  if (rawRow._transportCsv && looksLikeTransportCsvLine(rawRow._transportCsv)) {
    return String(rawRow._transportCsv).trim();
  }

  const candidates = [];

  Object.entries(rawRow || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) {
      candidates.push(String(value).trim());
    }
    if (key && String(key).trim()) {
      candidates.push(String(key).trim());
    }
  });

  return candidates.find((candidate) => looksLikeTransportCsvLine(candidate)) || null;
};

const expandTransportRow = (rawRow = {}) => {
  const line = extractTransportCsvLine(rawRow);
  if (!line) return rawRow;

  const parsed = parseTransportCsvLine(line);
  if (!parsed) return rawRow;

  return {
    ...rawRow,
    legajo: parsed.legajo,
    per__cod: parsed.legajo,
    per__des: parsed.name,
    nombre: parsed.name,
    sector__des: parsed.centroCosto,
    tarcon__des: parsed.role,
    diacitacioningreso: parsed.startDate || rawRow.diacitacioningreso,
    horacitacioningreso: parsed.appointmentTime || parsed.horaRaw,
    appointmentTime: parsed.appointmentTime,
    destination: parsed.destination,
    company: parsed.company,
    role: parsed.role
  };
};

const parseTransportFromStoredCitacion = (citacion = {}) => {
  const candidates = [
    citacion.legajo,
    citacion.legajoNormalized,
    citacion.name,
    citacion.notes
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = parseTransportCsvLine(candidate);
    if (parsed) return parsed;
  }

  return null;
};

const looksLikeBrokenTransportCitacion = (citacion = {}) => {
  const candidates = [
    citacion.name,
    citacion.legajo,
    citacion.legajoNormalized,
    citacion.notes
  ].filter(Boolean);
  return candidates.some((value) => looksLikeTransportCsvLine(value)
    || String(value).includes(',"')
    || /^Legajo\s+\d{3,5},/i.test(String(value)));
};

/**
 * Indica si se puede reconstruir con confianza (campos mínimos claros).
 * No adivina fechas/nombres si el parseo falla o queda ambiguo.
 */
const canConfidentlyRepairCitacion = (citacion = {}) => {
  if (!looksLikeBrokenTransportCitacion(citacion)) return false;
  const parsed = parseTransportFromStoredCitacion(citacion);
  if (!parsed) return false;
  if (!parsed.name || parsed.name.includes(',') || looksLikeTransportCsvLine(parsed.name)) {
    return false;
  }
  const legajoDigits = String(parsed.legajo || '').replace(/\D/g, '');
  if (!/^\d{3,5}$/.test(legajoDigits)) return false;
  if (!parsed.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.startDate)) return false;
  if (!parsed.role && !parsed.destination) return false;
  return true;
};

const applyTransportParseToCitacion = (citacion = {}) => {
  const parsed = parseTransportFromStoredCitacion(citacion);
  if (!parsed) return citacion;

  const appointmentTime = parsed.appointmentTime
    || militaryTimeToHHMM(citacion.notes?.match(/hora ingreso:\s*(\S+)/i)?.[1]);
  const legajoDigits = String(parsed.legajo || '').replace(/\D/g, '') || String(parsed.legajo || '');
  const legajoNormalized = normalizeLegajo(legajoDigits) || legajoDigits;
  const name = parsed.name;
  const nameKey = buildNameTokens(name);

  return {
    ...citacion,
    legajo: legajoDigits,
    legajoNormalized,
    name,
    nameKey: nameKey || citacion.nameKey,
    nameTokens: nameKey || citacion.nameTokens,
    destination: parsed.destination || citacion.destination,
    company: parsed.company || citacion.company,
    role: parsed.role || citacion.role,
    startDate: parsed.startDate || citacion.startDate,
    appointmentDate: parsed.startDate || citacion.appointmentDate || citacion.startDate,
    appointmentTime: appointmentTime || citacion.appointmentTime,
    endDate: citacion.endDate || parsed.startDate || citacion.startDate
  };
};

/** Hidrata citaciones para lectura (listados / matching). Permanent/visit se dejan igual. */
const hydrateAuthorizationForRead = (authorization = {}) => {
  if (!authorization || typeof authorization !== 'object') return authorization;
  const type = String(authorization.type || '').toLowerCase();
  if (type && type !== 'citacion' && !looksLikeBrokenTransportCitacion(authorization)) {
    return authorization;
  }
  if (!looksLikeBrokenTransportCitacion(authorization)) return authorization;
  return applyTransportParseToCitacion(authorization);
};

module.exports = {
  parseCsvFields,
  militaryTimeToHHMM,
  looksLikeTransportCsvLine,
  looksLikeBrokenTransportCitacion,
  canConfidentlyRepairCitacion,
  parseTransportCsvLine,
  extractTransportCsvLine,
  expandTransportRow,
  parseTransportFromStoredCitacion,
  applyTransportParseToCitacion,
  hydrateAuthorizationForRead
};
