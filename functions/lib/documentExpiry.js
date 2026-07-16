/**
 * Vencimientos de documentos (ART, licencia, seguro, VTV, autorizaciones).
 * Fechas inválidas o ausentes → sin alerta (no se tratan como vencidas).
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeExpiryYmd = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim().slice(0, 10);
    return YMD_RE.test(trimmed) ? trimmed : null;
  }
  if (value && typeof value.toDate === 'function') {
    const d = value.toDate();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
};

const daysBetweenYmd = (fromYmd, toYmd) => {
  if (!fromYmd || !toYmd) return null;
  const a = new Date(`${fromYmd}T12:00:00-03:00`);
  const b = new Date(`${toYmd}T12:00:00-03:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
};

const bucketForDaysLeft = (daysLeft) => {
  if (daysLeft === null || daysLeft === undefined) return null;
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 7) return 'endingIn7';
  if (daysLeft <= 15) return 'endingIn15';
  if (daysLeft <= 30) return 'endingIn30';
  return null;
};

/**
 * @returns {null|{ endDate: string, daysLeft: number, bucket: string }}
 */
const evaluateExpiry = (rawDate, todayYmd) => {
  const endDate = normalizeExpiryYmd(rawDate);
  if (!endDate) return null;
  const daysLeft = daysBetweenYmd(todayYmd, endDate);
  const bucket = bucketForDaysLeft(daysLeft);
  if (!bucket) return null;
  return { endDate, daysLeft, bucket };
};

const KIND_LABELS = {
  authorization: 'Autorización',
  art: 'ART',
  license: 'Licencia',
  insurance: 'Seguro',
  vtv: 'VTV / revisión técnica'
};

const buildExpiryMessage = ({ kind, subject, endDate, daysLeft }) => {
  const kindLabel = KIND_LABELS[kind] || kind;
  if (daysLeft < 0) {
    const days = Math.abs(daysLeft);
    return `El ${kindLabel} de ${subject} está vencido (desde hace ${days} día${days === 1 ? '' : 's'}, ${endDate})`;
  }
  if (daysLeft === 0) {
    return `El ${kindLabel} de ${subject} vence hoy (${endDate})`;
  }
  return `El ${kindLabel} de ${subject} vence en ${daysLeft} día${daysLeft === 1 ? '' : 's'} (${endDate})`;
};

/**
 * Alcances de alerta por dominio (mismo criterio que la UI de permisos).
 * Admin ve todos los dominios.
 */
const resolveExpirationAlertScopes = ({ role, permissions = [] } = {}) => {
  const perms = Array.isArray(permissions) ? permissions : [];
  const isAdmin = role === 'admin';
  const has = (permission) => isAdmin || perms.includes(permission);
  return {
    authorizations: has('entries.view') || has('master.citaciones.read'),
    personal: has('master.personal.read'),
    vehicles: has('master.vehicles.read')
  };
};

const kindsAllowedByScopes = (scopes = {}) => {
  const kinds = new Set();
  if (scopes.authorizations) kinds.add('authorization');
  if (scopes.personal) {
    kinds.add('art');
    kinds.add('license');
  }
  if (scopes.vehicles) {
    kinds.add('insurance');
    kinds.add('vtv');
  }
  return kinds;
};

const filterAlertsByScopes = (alerts = [], scopes = {}) => {
  const allowed = kindsAllowedByScopes(scopes);
  return (Array.isArray(alerts) ? alerts : []).filter((item) => allowed.has(item?.kind));
};

/**
 * Citaciones diarias (startDate = endDate por diseño) no son alertas de vencimiento:
 * al pasar el día quedan "vencidas" pero ya cumplieron su función. Historial ≠ banner.
 * Permanent/visit solo alertan si tienen endDate explícito (sin fallback a startDate):
 * las permanentes de nómina suelen no tener fin y no deben parecer "vencidas".
 */
const shouldAlertAuthorizationExpiry = (authorization = {}) => {
  const type = String(authorization.type || '').toLowerCase().trim();
  if (!type || type === 'citacion') return false;
  return Boolean(normalizeExpiryYmd(authorization.endDate));
};

module.exports = {
  normalizeExpiryYmd,
  daysBetweenYmd,
  evaluateExpiry,
  bucketForDaysLeft,
  buildExpiryMessage,
  KIND_LABELS,
  resolveExpirationAlertScopes,
  kindsAllowedByScopes,
  filterAlertsByScopes,
  shouldAlertAuthorizationExpiry
};
