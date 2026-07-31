/**
 * Parser de nómina Bacar.
 * Soporta planilla clásica (Usuario/DNI/Turno/…) y Legajos Online
 * (Apellido/Nombre/CUIL/Áreas/Puestos/Fecha Nac./Sexo/…).
 */

const { stripAccents } = require('./normalize');
const { parseShift } = require('./shiftParser');
const { isCitacionRequiredArea, normalizeAreaKey } = require('./centroCostoGroups');
const { normalizeIdNumber } = require('../dniParser');

const INVALID_TIPO_MARKERS = ['eliminar', 'descargar archivos', 'onboarding', 'dar de baja', 'no hay templates'];

const DEFAULT_TURNO_RAW = 'Lu,Ma,Mi,Ju,Vi,Sa,Do 08:00 a 17:00';

const POLICY_TO_TIPO = {
  permanent_shift: 'PERMANENTE dentro del turno',
  permanent: 'PERMANENTE',
  citacion_shift: 'Ajustar citación',
  citacion: 'Con citación',
  previa: 'Autorización previa',
  unknown: ''
};

const normalizeHeader = (value = '') =>
  stripAccents(String(value || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const HEADER_ALIASES = {
  name: ['usuario', 'nombre completo', 'apellido y nombre', 'name'],
  lastName: ['apellido', 'apellidos'],
  firstName: ['nombre', 'nombres', 'primer nombre'],
  idNumber: ['dni', 'documento', 'idnumber'],
  cuil: ['cuil', 'cuit'],
  legajo: ['legajo', 'nro legajo'],
  role: ['rol', 'role', 'puestos', 'puesto'],
  area: ['areas', 'area', 'área', 'áreas'],
  centroCosto: ['c. costo', 'c costo', 'centro de costo', 'centros de costo', 'centro costo', 'cc'],
  email: ['email', 'e-mail', 'correo', 'mail'],
  phone: ['telefono', 'teléfono', 'celular', 'tel'],
  birthDate: ['fecha nac', 'fecha de nac', 'nacimiento', 'fecha nacimiento', 'birth'],
  sex: ['sexo', 'genero', 'género', 'sex'],
  estado: ['estado', 'activo', 'status'],
  turno: ['turno', 'horario'],
  conCitacion: ['con citacion', 'con citación', 'citacion', 'citación'],
  authorizationPolicy: ['tipo de autorizacion', 'tipo de autorización', 'tipo autorizacion', 'autorizacion']
};

const resolveRowKeys = (row = {}) => {
  const normalizedEntries = Object.entries(row).map(([key, value]) => [
    normalizeHeader(key),
    value
  ]);
  const resolved = {};

  Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
    const match = normalizedEntries.find(([key]) =>
      aliases.some((alias) => key === alias || key.includes(alias)));
    if (match) resolved[field] = match[1];
  });

  // Si "nombre" matcheó firstName y también hay lastName, no usar firstName como name.
  if (resolved.lastName && resolved.firstName && !row.Usuario && !row.usuario) {
    const nameKey = normalizeHeader(
      Object.keys(row).find((k) => ['usuario', 'nombre completo', 'apellido y nombre'].includes(normalizeHeader(k))) || ''
    );
    if (!nameKey) {
      // ok: name se arma abajo
    }
  }

  return resolved;
};

const buildDisplayName = (fields = {}) => {
  const full = String(fields.name || '').trim();
  if (full && !/^\d+$/.test(full)) {
    // Si vino solo el nombre de pila porque el alias "nombre" matcheó, preferir Apellido+Nombre
    const last = String(fields.lastName || '').trim();
    const first = String(fields.firstName || '').trim();
    if (last && first && full === first) {
      return `${last} ${first}`.trim();
    }
    return full;
  }
  const last = String(fields.lastName || '').trim();
  const first = String(fields.firstName || '').trim();
  return `${last} ${first}`.trim();
};

const normalizeCuil = (value = '') => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11) {
    return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
  }
  const raw = String(value || '').trim();
  return raw || '';
};

const parseBirthDate = (value = '') => {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial date
    const epoch = Date.UTC(1899, 11, 30);
    const dt = new Date(epoch + value * 86400000);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString().slice(0, 10);
    }
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    return `${m[3]}-${month}-${day}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
};

const normalizeSex = (value = '') => {
  const s = stripAccents(String(value || '')).toLowerCase().trim();
  if (!s) return '';
  if (s.startsWith('f') || s === 'mujer') return 'Femenino';
  if (s.startsWith('m') || s === 'hombre' || s === 'varon') return 'Masculino';
  return String(value).trim();
};

const isActiveEstado = (value = '') => {
  const s = stripAccents(String(value || '')).toLowerCase().trim();
  if (!s) return true;
  if (['inactivo', 'baja', 'inactive', 'no', 'false', '0'].includes(s)) return false;
  return true;
};

const buildNominaRowFromFields = (fields = {}) => {
  const policyCode = String(fields.authorizationPolicy || '').trim();
  const tipo = POLICY_TO_TIPO[policyCode]
    || String(fields.authorizationPolicyRaw || fields.tipoAutorizacion || policyCode || 'PERMANENTE');
  const conCitacion = fields.requiresCitacion === true
    || fields.requiresCitacion === 'true'
    || /^si$/i.test(String(fields.conCitacion || '').trim())
    ? 'SI'
    : 'NO';

  return {
    Usuario: fields.name || fields.Usuario || '',
    Apellido: fields.lastName || '',
    Nombre: fields.firstName || '',
    DNI: fields.idNumber || fields.DNI || '',
    CUIL: fields.cuil || '',
    Legajo: fields.legajo || fields.Legajo || '',
    Rol: fields.role || fields.Rol || fields.puesto || '',
    Puestos: fields.puesto || fields.role || '',
    Áreas: fields.area || '',
    'C. Costo': fields.centroCosto || fields['C. Costo'] || '',
    'Centros de Costo': fields.centroCosto || '',
    Email: fields.email || '',
    Teléfono: fields.phone || '',
    'Fecha Nac.': fields.birthDate || '',
    Sexo: fields.sex || '',
    Estado: fields.active === false ? 'Inactivo' : 'Activo',
    Turno: fields.turnoRaw || fields.Turno || fields.turno || DEFAULT_TURNO_RAW,
    'Con citacion': conCitacion,
    'Tipo de autorizacion': tipo
  };
};

const normalizeTipoText = (raw = '') =>
  stripAccents(String(raw || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const matchAuthPolicy = (tipo = '') => {
  if (/permanente dentro del turno/.test(tipo)) {
    return { policy: 'permanent_shift', requiresCitacion: false, createPermanent: true };
  }
  if (tipo === 'permanente' || /^permanente(\s|$)/.test(tipo)) {
    return { policy: 'permanent', requiresCitacion: false, createPermanent: true };
  }
  if (/ajustar citaci/.test(tipo)) {
    return { policy: 'citacion_shift', requiresCitacion: true, createPermanent: false };
  }
  if (/con citaci/.test(tipo)) {
    return { policy: 'citacion', requiresCitacion: true, createPermanent: false };
  }
  if (/autorizaci.n previa/.test(tipo)) {
    return { policy: 'previa', requiresCitacion: false, createPermanent: false };
  }
  return null;
};

const parseAuthPolicy = (tipoRaw = '', conCitacionRaw = '') => {
  const head = normalizeTipoText(tipoRaw).slice(0, 80);
  const full = normalizeTipoText(tipoRaw);
  const cit = stripAccents(String(conCitacionRaw || '')).toUpperCase().trim();
  const requiresCitacion = cit === 'SI' || cit === 'SÍ' || /^SI$/i.test(cit);

  let matched = matchAuthPolicy(head) || matchAuthPolicy(full);
  if (matched) {
    if (requiresCitacion && matched.policy === 'permanent') {
      return { policy: 'citacion_shift', requiresCitacion: true, createPermanent: false };
    }
    if (requiresCitacion && matched.policy === 'permanent_shift') {
      return matched;
    }
    return matched;
  }

  if (!full) {
    if (requiresCitacion) {
      return { policy: 'citacion_shift', requiresCitacion: true, createPermanent: false };
    }
    return { policy: 'permanent_shift', requiresCitacion: false, createPermanent: true };
  }

  const hasInvalidMarker = INVALID_TIPO_MARKERS.some((marker) => full.includes(marker));
  if (hasInvalidMarker || full.length > 80) {
    if (/^permanente/.test(head)) {
      return { policy: 'permanent', requiresCitacion: false, createPermanent: true };
    }
    if (/^ajustar citaci/.test(head)) {
      return { policy: 'citacion_shift', requiresCitacion: true, createPermanent: false };
    }
    if (requiresCitacion) {
      return { policy: 'citacion', requiresCitacion: true, createPermanent: false };
    }
    return null;
  }

  if (requiresCitacion) {
    return { policy: 'citacion', requiresCitacion: true, createPermanent: false };
  }

  return { policy: 'unknown', requiresCitacion: false, createPermanent: false };
};

const needsCitacionByArea = (area = '', centroCosto = '') => {
  if (isCitacionRequiredArea(centroCosto) || isCitacionRequiredArea(area)) return true;
  const key = normalizeAreaKey(area);
  return key === 'transporte' || key === 'tesoreria';
};

const parseNominaRow = (row = {}, options = {}) => {
  const fields = resolveRowKeys(row);
  const name = buildDisplayName(fields);
  const idNumberNormalized = normalizeIdNumber(fields.idNumber);
  const legajoNormalized = String(fields.legajo || '').trim();
  const puesto = String(fields.role || '').trim();
  const area = String(fields.area || '').trim();
  const centroCosto = String(fields.centroCosto || '').trim();
  const email = String(fields.email || '').trim().toLowerCase();
  const phone = String(fields.phone || '').replace(/\s+/g, '').trim();
  const cuil = normalizeCuil(fields.cuil);
  const birthDate = parseBirthDate(fields.birthDate);
  const sex = normalizeSex(fields.sex);
  const active = isActiveEstado(fields.estado);
  const lastName = String(fields.lastName || '').trim();
  const firstName = String(fields.firstName || '').trim();

  const defaultTurno = options.defaultTurnoRaw || DEFAULT_TURNO_RAW;
  let turnoRaw = String(fields.turno || '').trim();
  if (!turnoRaw) turnoRaw = defaultTurno;
  const shiftSchedule = parseShift(turnoRaw);

  // Defaults de autorización si el Excel Legajos no trae esas columnas
  let tipoRaw = fields.authorizationPolicy;
  let conCitacionRaw = fields.conCitacion;
  const inferredCitacion = needsCitacionByArea(area, centroCosto);
  if (tipoRaw == null || String(tipoRaw).trim() === '') {
    tipoRaw = inferredCitacion
      ? 'Ajustar citación'
      : 'PERMANENTE dentro del turno';
  }
  if (conCitacionRaw == null || String(conCitacionRaw).trim() === '') {
    conCitacionRaw = inferredCitacion ? 'SI' : 'NO';
  }

  const authMeta = parseAuthPolicy(tipoRaw, conCitacionRaw);

  if (!name) {
    return { valid: false, reason: 'nombre_vacio' };
  }
  if (!idNumberNormalized && !legajoNormalized) {
    return { valid: false, reason: 'sin_dni_ni_legajo', name };
  }
  if (!authMeta) {
    return { valid: false, reason: 'tipo_autorizacion_invalido', name };
  }

  let requiresCitacion = authMeta.requiresCitacion
    || (authMeta.policy === 'citacion_shift');
  // Solo forzar citación en áreas que la usan (transporte / tesorería)
  if (!needsCitacionByArea(area, centroCosto)) {
    requiresCitacion = false;
  } else if (inferredCitacion && !fields.authorizationPolicy && !fields.conCitacion) {
    requiresCitacion = true;
  }

  let authorizationPolicy = authMeta.policy;
  let createPermanent = authMeta.createPermanent;
  if (requiresCitacion && authorizationPolicy === 'permanent_shift') {
    // En transporte: citación del jefe + ventana de turno
    authorizationPolicy = 'citacion_shift';
    createPermanent = false;
  }
  if (requiresCitacion && authorizationPolicy === 'permanent') {
    authorizationPolicy = 'citacion_shift';
    createPermanent = false;
  }

  return {
    valid: true,
    name,
    lastName,
    firstName,
    idNumber: idNumberNormalized,
    idNumberNormalized,
    legajo: legajoNormalized,
    legajoNormalized,
    role: puesto,
    puesto,
    area,
    centroCosto,
    company: centroCosto || area,
    email,
    phone,
    cuil,
    birthDate,
    sex,
    active,
    turnoRaw,
    shiftSchedule,
    requiresCitacion,
    authorizationPolicy,
    createPermanent,
    conCitacionRaw: String(conCitacionRaw || '').trim()
  };
};

module.exports = {
  parseNominaRow,
  parseAuthPolicy,
  resolveRowKeys,
  buildNominaRowFromFields,
  buildDisplayName,
  parseBirthDate,
  normalizeCuil,
  normalizeSex,
  DEFAULT_TURNO_RAW,
  POLICY_TO_TIPO,
  needsCitacionByArea
};
