const { stripAccents } = require('./normalize');
const { parseShift } = require('./shiftParser');
const { normalizeIdNumber } = require('../dniParser');

const INVALID_TIPO_MARKERS = ['eliminar', 'descargar archivos', 'onboarding', 'dar de baja', 'no hay templates'];

const normalizeHeader = (value = '') =>
  stripAccents(String(value || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const HEADER_ALIASES = {
  name: ['usuario', 'nombre', 'name', 'apellido y nombre'],
  idNumber: ['dni', 'documento', 'idnumber'],
  legajo: ['legajo', 'nro legajo'],
  role: ['rol', 'role'],
  centroCosto: ['c. costo', 'c costo', 'centro de costo', 'centro costo', 'cc'],
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
    const match = normalizedEntries.find(([key]) => aliases.some((alias) => key === alias || key.includes(alias)));
    if (match) resolved[field] = match[1];
  });

  return resolved;
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
      return { policy: 'citacion', requiresCitacion: true, createPermanent: false };
    }
    return { policy: 'permanent', requiresCitacion: false, createPermanent: true };
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

const parseNominaRow = (row = {}) => {
  const fields = resolveRowKeys(row);
  const name = String(fields.name || '').trim();
  const idNumberNormalized = normalizeIdNumber(fields.idNumber);
  const legajoNormalized = String(fields.legajo || '').trim();
  const role = String(fields.role || '').trim();
  const centroCosto = String(fields.centroCosto || '').trim();
  const turnoRaw = String(fields.turno || '').trim();
  const shiftSchedule = parseShift(turnoRaw);
  const authMeta = parseAuthPolicy(fields.authorizationPolicy, fields.conCitacion);

  if (!name) {
    return { valid: false, reason: 'nombre_vacio' };
  }
  if (!idNumberNormalized && !legajoNormalized) {
    return { valid: false, reason: 'sin_dni_ni_legajo', name };
  }
  if (!authMeta) {
    return { valid: false, reason: 'tipo_autorizacion_invalido', name };
  }

  const requiresCitacion = authMeta.requiresCitacion
    || (authMeta.policy === 'citacion_shift');

  return {
    valid: true,
    name,
    idNumber: idNumberNormalized,
    idNumberNormalized,
    legajo: legajoNormalized,
    legajoNormalized,
    role,
    centroCosto,
    company: centroCosto,
    turnoRaw,
    shiftSchedule,
    requiresCitacion,
    authorizationPolicy: authMeta.policy,
    createPermanent: authMeta.createPermanent,
    conCitacionRaw: String(fields.conCitacion || '').trim()
  };
};

module.exports = {
  parseNominaRow,
  parseAuthPolicy,
  resolveRowKeys
};
