const { normalizeIdNumber } = require('./dniParser');
const { buildAuthorizationRecord, todayDateString } = require('./authorizations');
const { buildNameTokens } = require('./lib/nameUtils');
const { normalizeLegajo, findMasterForCitacionRow } = require('./lib/personMatch');
const { expandTransportRow } = require('./lib/transportCsvParser');

const COLUMN_ALIASES = {
  type: ['tipo', 'type', 'categoria', 'clasificacion', 'tarcon__des', 'tarcon_des'],
  name: ['nombre', 'name', 'apellido y nombre', 'apellido_y_nombre', 'nombre completo', 'nombre_completo', 'empleado', 'persona', 'conductor', 'chofer', 'personal', 'per__des', 'per_des'],
  lastName: ['apellido', 'apellidos', 'lastname', 'last_name'],
  firstName: ['nombres', 'nombre_pila', 'firstname', 'first_name'],
  legajo: ['legajo', 'nro_legajo', 'nro legajo', 'numero_legajo', 'per', 'per__cod', 'per_cod', 'cod_per', 'codigo', 'interno', 'nro_per'],
  idNumber: ['dni', 'documento', 'cuil', 'idnumber', 'id_number', 'nro documento', 'nro_documento', 'nro dni', 'nro_doc', 'nrodoc', 'numero_documento', 'num_documento', 'n_documento', 'doc', 'cedula', 'identificacion'],
  company: ['empresa', 'company', 'contratista', 'transporte', 'transportista', 'firma', 'proveedor', 'tarcon__des', 'tarcon_des'],
  destination: ['destino', 'destination', 'area', 'sector', 'lugar', 'planta', 'puesto', 'ubicacion', 'servicio', 'sector__des', 'sector_des'],
  startDate: ['fecha_inicio', 'fecha inicio', 'fecha', 'fecha_citacion', 'fecha citacion', 'dia', 'date', 'appointmentdate', 'fecha_cita', 'diacitacioningreso', 'diacitacion_ingreso'],
  endDate: ['fecha_fin', 'fecha fin', 'fecha_hasta', 'hasta', 'vencimiento', 'diacitacionsalida', 'diacitacion_salida'],
  notes: ['observaciones', 'notes', 'nota', 'comentario', 'horacitacioningreso', 'horacitacion_ingreso']
};

const SPANISH_MONTHS = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12'
};

const HEADER_SKIP_VALUES = new Set(['nombre', 'apellido', 'dni', 'documento', 'legajo', 'empresa', 'destino', 'fecha', 'per__des', 'sector__des']);

const inferDateFromSourceFile = (sourceFile = '') => {
  const match = String(sourceFile).match(/Citaciones_(\d{4})_(\d{2})_(\d{2})/i);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const normalizeHeader = (value) =>
  String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');

const cleanCell = (value) => String(value ?? '').replace(/^"|"$/g, '').trim();

const pickValue = (row, keys) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && cleanCell(row[key]) !== '') {
      return cleanCell(row[key]);
    }
  }
  return null;
};

const fuzzyPickByKey = (row, fragments) => {
  for (const [key, value] of Object.entries(row || {})) {
    if (value === undefined || value === null || cleanCell(value) === '') continue;
    const normalizedKey = normalizeHeader(key);
    if (fragments.some((fragment) => normalizedKey.includes(fragment))) {
      return cleanCell(value);
    }
  }
  return null;
};

const buildPersonName = (row, get) => {
  const transportName = pickValue(row, ['per__des', 'per_des']);
  if (transportName) return transportName;

  const fullName = get('name');
  if (fullName && !HEADER_SKIP_VALUES.has(normalizeHeader(fullName))) {
    return fullName;
  }

  const lastName = get('lastName') || fuzzyPickByKey(row, ['apellido']);
  const firstName = get('firstName') || fuzzyPickByKey(row, ['nombre']);
  const combined = [lastName, firstName]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  if (combined && !HEADER_SKIP_VALUES.has(normalizeHeader(combined))) {
    return combined.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const fallbackName = fuzzyPickByKey(row, ['empleado', 'persona', 'conductor', 'chofer', 'personal']);
  return fallbackName ? String(fallbackName).replace(/,/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

const excelDateToIso = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);

    const spanishMatch = trimmed.match(/^(\d{1,2})[-\/]([A-Za-z]{3})[-\/](\d{4})$/);
    if (spanishMatch) {
      const month = SPANISH_MONTHS[spanishMatch[2].toLowerCase().slice(0, 3)];
      if (month) {
        return `${spanishMatch[3]}-${month}-${spanishMatch[1].padStart(2, '0')}`;
      }
    }

    const parts = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (parts) {
      const day = parts[1].padStart(2, '0');
      const month = parts[2].padStart(2, '0');
      let year = parts[3];
      if (year.length === 2) year = `20${year}`;
      return `${year}-${month}-${day}`;
    }
    return null;
  }
  if (typeof value === 'number' && value > 20000) {
    const utcDays = Math.floor(value - 25569);
    const date = new Date(utcDays * 86400000);
    return date.toISOString().slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return date.toISOString().slice(0, 10);
  }
  return null;
};

/**
 * Fechas ISO / dd-mm-yyyy se normalizan a 8 dígitos (ej. 2026-07-16 → 20260716)
 * y se confunden con un DNI. No usarlas como documento.
 */
const looksLikeDateAsIdNumber = (value) => {
  const raw = cleanCell(value);
  if (!raw) return false;
  return Boolean(excelDateToIso(raw));
};

const sanitizeIdNumberCandidate = (value) => {
  if (value === undefined || value === null || cleanCell(value) === '') return null;
  if (looksLikeDateAsIdNumber(value)) return null;
  return cleanCell(value);
};

const findIdNumberInRow = (row) => {
  const preferred = sanitizeIdNumberCandidate(
    fuzzyPickByKey(row, ['dni', 'documento', 'doc', 'cuil', 'cedula'])
  );
  if (preferred) return preferred;

  for (const [key, value] of Object.entries(row || {})) {
    if (value === undefined || value === null || cleanCell(value) === '') continue;
    const normalizedKey = normalizeHeader(key);
    if (normalizedKey === 'legajo' || normalizedKey.includes('legajo')) continue;
    if (['telefono', 'celular', 'patente', 'dominio', 'interno', 'hora', 'fecha', 'dia', 'date', 'citacion'].some((skip) => normalizedKey.includes(skip))) {
      continue;
    }
    if (looksLikeDateAsIdNumber(value)) continue;
    const digits = normalizeIdNumber(value);
    if (digits.length >= 7 && digits.length <= 8) {
      return cleanCell(value);
    }
  }
  return null;
};

const normalizeRowKeys = (row) => {
  const normalized = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    normalized[normalizeHeader(key)] = value;
  });
  return normalized;
};

const resolveIdNumberFromMaster = (legajo, name, defaults = {}) => {
  const legajoKey = String(legajo || '').trim();
  if (legajoKey && defaults.masterByLegajo?.[legajoKey]?.idNumber) {
    return defaults.masterByLegajo[legajoKey].idNumber;
  }
  const nameKey = String(name || '').trim().toLowerCase();
  if (nameKey && defaults.masterByName?.[nameKey]?.idNumber) {
    return defaults.masterByName[nameKey].idNumber;
  }
  return null;
};

const normalizeImportRow = (rawRow, defaults = {}) => {
  const expandedRow = expandTransportRow(rawRow);
  const row = normalizeRowKeys(expandedRow);
  const get = (field) => pickValue(row, COLUMN_ALIASES[field].map(normalizeHeader));

  const typeRaw = String(get('type') || defaults.type || 'citacion').toLowerCase();
  const type = typeRaw.includes('perman') ? 'permanent'
    : typeRaw.includes('visit') ? 'visit'
    : 'citacion';

  const legajo = get('legajo') || fuzzyPickByKey(row, ['legajo']);
  const name = buildPersonName(row, get);
  let idNumber = sanitizeIdNumberCandidate(get('idNumber')) || findIdNumberInRow(row);
  if (!idNumber) {
    idNumber = resolveIdNumberFromMaster(legajo, name, defaults);
  }

  const startDate = excelDateToIso(get('startDate'))
    || defaults.startDate
    || inferDateFromSourceFile(defaults.sourceFile)
    || todayDateString();
  const endDate = excelDateToIso(get('endDate')) || (type === 'citacion' ? startDate : defaults.endDate);

  // Defensa: si el "DNI" es la fecha de citación sin guiones (20260716), descartarlo.
  if (idNumber && normalizeIdNumber(idNumber) === normalizeIdNumber(startDate)) {
    idNumber = null;
  }

  const destination = pickValue(row, ['sector__des', 'sector_des'])
    || get('destination')
    || fuzzyPickByKey(row, ['destino', 'sector', 'planta', 'area'])
    || defaults.destination
    || '';

  const role = pickValue(row, ['tarcon__des', 'tarcon_des'])
    || fuzzyPickByKey(row, ['tarcon'])
    || '';

  const company = get('company')
    || fuzzyPickByKey(row, ['empresa', 'contratista', 'transporte'])
    || defaults.company
    || '';

  const horaIngreso = pickValue(row, ['horacitacioningreso', 'horacitacion_ingreso'])
    || expandedRow.appointmentTime
    || null;
  const notes = [get('notes'), horaIngreso ? `Hora ingreso: ${horaIngreso}` : '']
    .filter(Boolean)
    .join(' | ');

  let normalized = {
    type,
    name,
    idNumber,
    legajo,
    company,
    destination,
    role,
    startDate,
    endDate,
    notes,
    appointmentTime: horaIngreso || null
  };

  const master = findMasterForCitacionRow(normalized, defaults);
  if (master) {
    normalized = {
      ...normalized,
      name: master.name || normalized.name,
      legajo: master.legajoNormalized || master.legajo || normalized.legajo,
      idNumber: master.idNumberNormalized || master.idNumber || normalized.idNumber
    };
  }

  return normalized;
};

const isEmptyImportRow = (rawRow) =>
  !Object.values(rawRow || {}).some((value) => cleanCell(value) !== '');

const parseImportRows = (rows, defaults = {}) => {
  const parsed = [];
  const errors = [];

  (rows || []).forEach((rawRow, index) => {
    if (isEmptyImportRow(rawRow)) return;

    try {
      const normalized = normalizeImportRow(rawRow, defaults);
      const record = buildAuthorizationRecord(normalized);
      parsed.push(record);
    } catch (err) {
      errors.push({ row: index + 1, message: err.message });
    }
  });

  return { parsed, errors };
};

const buildMasterLookups = (docs = []) => {
  const masterByLegajo = {};
  const masterByName = {};
  const masterByNameKey = {};
  const masterList = [];

  docs.forEach((doc) => {
    const data = typeof doc.data === 'function' ? doc.data() : doc;
    if (data.source && data.source !== 'nomina') return;
    if (data.active === false) return;

    masterList.push(data);

    const legajoRaw = String(data.legajoNormalized || data.legajo || '').trim();
    const legajoNorm = normalizeLegajo(legajoRaw);
    if (legajoRaw) masterByLegajo[legajoRaw] = data;
    if (legajoNorm) masterByLegajo[legajoNorm] = data;

    const nameKey = data.nameKey || buildNameTokens(data.name);
    if (nameKey) masterByNameKey[nameKey] = data;

    const nameLower = String(data.nameLower || data.name || '').trim().toLowerCase();
    if (nameLower) masterByName[nameLower] = data;
  });

  return { masterByLegajo, masterByName, masterByNameKey, masterList };
};

module.exports = {
  COLUMN_ALIASES,
  normalizeImportRow,
  parseImportRows,
  excelDateToIso,
  inferDateFromSourceFile,
  looksLikeDateAsIdNumber,
  findIdNumberInRow,
  buildMasterLookups
};
