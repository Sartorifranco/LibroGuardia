/**
 * Normalización/validación de empresas y destinos (predio multi-empresa).
 */

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Formato canónico de dominio (para D2 / autoregistro):
 * - Sin @ (si viene "@vespasiani.com" o "user@vespasiani.com", se toma solo el host)
 * - Minúsculas
 * - Sin espacios ni barra final
 * Ejemplos válidos: vespasiani.com, mail.empresa.com.ar
 */
const normalizeDomain = (raw = '') => {
  let value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('mailto:')) value = value.slice(7);
  if (value.includes('@')) {
    value = value.split('@').pop() || '';
  }
  value = value.replace(/\.+$/, '').replace(/^\.+/, '');
  return value.trim();
};

const isValidDomain = (domain) => DOMAIN_RE.test(String(domain || ''));

const normalizeDomainList = (list = []) => {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const d = normalizeDomain(item);
    if (!d) continue;
    if (!isValidDomain(d)) {
      const err = new Error(`Dominio inválido: "${item}". Usá el host sin @ (ej. vespasiani.com).`);
      err.status = 400;
      err.code = 'invalid_domain';
      throw err;
    }
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
};

/**
 * Valida que cada doorId exista en doorsConfig.doors (cualquier active).
 * @returns {string[]} doorIds normalizados únicos
 */
const validateDestinationDoorIds = (doorIds, doorsConfig) => {
  const known = new Set((doorsConfig?.doors || []).map((d) => String(d.id || '').trim()).filter(Boolean));
  const raw = Array.isArray(doorIds) ? doorIds : [];
  const unique = [];
  const seen = new Set();
  for (const id of raw) {
    const doorId = String(id || '').trim();
    if (!doorId) continue;
    if (!known.has(doorId)) {
      const err = new Error(`Puerta inexistente en la configuración: "${doorId}"`);
      err.status = 400;
      err.code = 'unknown_door';
      err.doorId = doorId;
      throw err;
    }
    if (seen.has(doorId)) continue;
    seen.add(doorId);
    unique.push(doorId);
  }
  return unique;
};

const sanitizeEmpresaPayload = (body = {}) => {
  const nombre = String(body.nombre || body.name || '').trim();
  if (!nombre) {
    const err = new Error('El nombre de la empresa es obligatorio');
    err.status = 400;
    throw err;
  }
  const dominiosPermitidos = normalizeDomainList(body.dominiosPermitidos || body.domains || []);
  const activa = body.activa !== false && body.active !== false;
  return { nombre, dominiosPermitidos, activa };
};

const sanitizeDestinoPayload = (body = {}, doorsConfig) => {
  const nombre = String(body.nombre || body.name || '').trim();
  if (!nombre) {
    const err = new Error('El nombre del destino es obligatorio');
    err.status = 400;
    throw err;
  }
  const doorIds = validateDestinationDoorIds(body.doorIds || body.puertas || [], doorsConfig);
  const activo = body.activo !== false && body.active !== false;
  return { nombre, doorIds, activo };
};

module.exports = {
  DOMAIN_RE,
  normalizeDomain,
  isValidDomain,
  normalizeDomainList,
  validateDestinationDoorIds,
  sanitizeEmpresaPayload,
  sanitizeDestinoPayload
};
