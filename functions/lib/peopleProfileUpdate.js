/**
 * Validación / armado de patch para editar ficha básica de people
 * (nombre, legajo, DNI, activo, notas) + allowedDoorIds.
 */

const { normalizeIdNumber } = require('../dniParser');
const { normalizeLegajo } = require('./personMatch');
const { normalizePersonName, buildNameTokens } = require('./nameUtils');
const { normalizeAllowedDoorIds } = require('./doorAccess');

const personToAdminJSON = (doc) => {
  const data = (doc && typeof doc.data === 'function' ? doc.data() : doc) || {};
  const id = doc?.id || data.id || '';
  return {
    id,
    name: data.nombre || data.name || '',
    legajo: data.legajoNormalized || data.legajo || '',
    idNumber: data.dniNormalized || data.idNumberNormalized || data.dni || data.idNumber || '',
    company: data.company || data.empresa || data.centroCosto || '',
    active: data.active !== false,
    notas: data.notas || data.notes || '',
    allowedDoorIds: normalizeAllowedDoorIds(data.allowedDoorIds)
  };
};

/**
 * Arma el patch de actualización a partir del body.
 * No consulta Firestore (unicidad se chequea aparte).
 * @returns {{ ok: true, patch: object } | { ok: false, status: number, message: string }}
 */
const buildPersonProfilePatch = (existing = {}, body = {}) => {
  const patch = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);

  if (has('name') || has('nombre')) {
    const name = String(body.name ?? body.nombre ?? '').trim();
    if (!name) {
      return { ok: false, status: 400, message: 'El nombre no puede quedar vacío' };
    }
    patch.nombre = name;
    patch.name = name;
    patch.nameLower = normalizePersonName(name);
    patch.nameKey = buildNameTokens(name);
    patch.nameTokens = patch.nameKey;
  }

  if (has('legajo')) {
    const legajoRaw = String(body.legajo ?? '').trim();
    const legajoNormalized = legajoRaw ? normalizeLegajo(legajoRaw) : '';
    patch.legajo = legajoNormalized || null;
    patch.legajoNormalized = legajoNormalized || null;
  }

  if (has('idNumber') || has('dni')) {
    const idNumber = normalizeIdNumber(body.idNumber ?? body.dni ?? '');
    patch.dni = idNumber || null;
    patch.dniNormalized = idNumber || null;
    patch.idNumber = idNumber || '';
    patch.idNumberNormalized = idNumber || '';
  }

  if (has('active') || has('activo')) {
    const raw = has('active') ? body.active : body.activo;
    patch.active = raw === true || raw === 'true' || raw === 1 || raw === '1';
  }

  if (has('notas') || has('notes')) {
    const notas = String(body.notas ?? body.notes ?? '').trim().slice(0, 500);
    patch.notas = notas;
  }

  if (has('allowedDoorIds')) {
    patch.allowedDoorIds = normalizeAllowedDoorIds(body.allowedDoorIds);
  }

  return { ok: true, patch };
};

/**
 * Detecta conflicto de unicidad contra otra persona.
 * @param {{ id: string }[]} matches docs que ya tienen el valor
 * @param {string} personId id que estamos editando
 */
const hasForeignConflict = (matches = [], personId) =>
  matches.some((doc) => String(doc.id) !== String(personId));

module.exports = {
  personToAdminJSON,
  buildPersonProfilePatch,
  hasForeignConflict
};
