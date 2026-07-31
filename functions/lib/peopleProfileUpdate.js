/**
 * Validación / armado de patch para editar ficha básica de people
 * (nombre, legajo, DNI, activo, notas) + allowedDoorIds.
 */

const { normalizeIdNumber } = require('../dniParser');
const { normalizeLegajo } = require('./personMatch');
const { normalizePersonName, buildNameTokens } = require('./nameUtils');
const { normalizeAllowedDoorIds } = require('./doorAccess');
const { normalizePhotoDataUrl } = require('./personPhoto');

const CATEGORIES = ['empleado', 'tercero', 'cliente', 'sin_clasificar'];

const resolveCategory = (data = {}) => {
  const raw = String(data.category || '').trim().toLowerCase();
  if (CATEGORIES.includes(raw)) return raw;
  const tipo = String(data.tipo || '').toLowerCase();
  if (tipo === 'visita' || tipo === 'cliente') return 'cliente';
  if (tipo === 'temporal' || tipo === 'tercero' || tipo === 'contratista') return 'tercero';
  if (data.source === 'biostar' && !(data.dniNormalized || data.idNumberNormalized || data.dni)) {
    return 'sin_clasificar';
  }
  if (tipo === 'empleado' || data.legajoNormalized || data.legajo) return 'empleado';
  if (data.source === 'biostar') return 'sin_clasificar';
  return 'sin_clasificar';
};

const personToAdminJSON = (doc) => {
  const data = (doc && typeof doc.data === 'function' ? doc.data() : doc) || {};
  const id = doc?.id || data.id || '';
  return {
    id,
    name: data.nombre || data.name || '',
    legajo: data.legajoNormalized || data.legajo || '',
    idNumber: data.dniNormalized || data.idNumberNormalized || data.dni || data.idNumber || '',
    company: data.company || data.empresa || data.centroCosto || '',
    area: data.area || '',
    puesto: data.puesto || data.role || '',
    cuil: data.cuil || '',
    email: data.email || '',
    phone: data.phone || '',
    birthDate: data.birthDate || null,
    sex: data.sex || '',
    active: data.active !== false,
    notas: data.notas || data.notes || '',
    photoDataUrl: data.photoDataUrl || null,
    accessCard: data.accessCard || '',
    biometricExternalId: data.biometricExternalId || '',
    biometricBrand: data.biometricBrand || '',
    biostarUserId: data.biostarUserId || '',
    source: data.source || data.origen || '',
    origen: data.origen || '',
    mergedIntoId: data.mergedIntoId || null,
    category: resolveCategory(data),
    nameKey: data.nameKey || '',
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

  if (has('photoDataUrl') || has('photoUrl')) {
    const raw = has('photoDataUrl') ? body.photoDataUrl : body.photoUrl;
    if (raw === null || raw === '') {
      patch.photoDataUrl = null;
    } else {
      const photo = normalizePhotoDataUrl(raw);
      if (!photo.ok) {
        return { ok: false, status: 400, message: photo.message };
      }
      patch.photoDataUrl = photo.value;
    }
  }

  if (has('accessCard') || has('cardCode') || has('credentialCode')) {
    const raw = String(body.accessCard ?? body.cardCode ?? body.credentialCode ?? '').trim();
    patch.accessCard = raw ? raw.toUpperCase() : null;
  }

  if (has('biometricExternalId') || has('biometricId')) {
    const raw = String(body.biometricExternalId ?? body.biometricId ?? '').trim();
    patch.biometricExternalId = raw || null;
  }

  if (has('biometricBrand') || has('biometricVendor')) {
    const raw = String(body.biometricBrand ?? body.biometricVendor ?? '').trim().toLowerCase();
    patch.biometricBrand = raw || null;
  }

  if (has('category')) {
    const raw = String(body.category || '').trim().toLowerCase();
    if (raw && !CATEGORIES.includes(raw)) {
      return { ok: false, status: 400, message: 'category inválida' };
    }
    patch.category = raw || 'sin_clasificar';
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
  hasForeignConflict,
  resolveCategory,
  CATEGORIES
};
