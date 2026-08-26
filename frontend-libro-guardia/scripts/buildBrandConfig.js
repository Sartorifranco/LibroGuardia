/**
 * Arma el objeto de marca a partir de pocos datos de entrada.
 * No escribe archivos: eso lo hace scaffold-brand.js.
 */

const REQUIRED_KEYS = ['companyName'];

const DEFAULTS = {
  appTitle: 'MSS Guard',
  kioskTitle: 'Control de Acceso',
  kioskSubtitle: 'Escanee su DNI o QR para ingresar',
  loginUsernamePlaceholder: 'Ingrese su usuario',
  backgroundColor: '#0a0a0a',
  primaryColor: '#e11d2e'
};

const slugify = (value) => {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'cliente';
};

const normalizeHex = (value, fallback) => {
  const raw = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return fallback;
};

const darkenHex = (hex, amount = 0.18) => {
  const raw = String(hex || '').replace('#', '');
  if (raw.length !== 6) return hex;
  const nums = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
  if (nums.some((n) => Number.isNaN(n))) return hex;
  const mixed = nums.map((n) => Math.max(0, Math.round(n * (1 - amount))));
  return `#${mixed.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
};

const fileNameFromLogoPath = (logoPath) => {
  const trimmed = String(logoPath || '').replace(/\\/g, '/').split('/').pop();
  return trimmed || 'logo.png';
};

const toPublicLogoPath = (logoPathOrFile) => {
  const name = fileNameFromLogoPath(logoPathOrFile);
  return `/${name}`;
};

const buildBrandConfig = (input = {}) => {
  const missing = REQUIRED_KEYS.filter((key) => !String(input[key] || '').trim());
  if (missing.length) {
    const err = new Error(`Faltan campos obligatorios: ${missing.join(', ')}`);
    err.code = 'BRAND_REQUIRED';
    throw err;
  }

  const companyName = String(input.companyName).trim();
  const slug = slugify(input.slug || companyName);
  const appTitle = String(input.appTitle || DEFAULTS.appTitle).trim();
  const primaryColor = normalizeHex(input.primaryColor, DEFAULTS.primaryColor);
  const primaryColorHover = normalizeHex(
    input.primaryColorHover,
    darkenHex(primaryColor, 0.18)
  );
  const backgroundColor = normalizeHex(input.backgroundColor, DEFAULTS.backgroundColor);
  const logoPath = toPublicLogoPath(input.logoPath || input.logoFile || 'logo.png');
  const publicOrigin = String(input.publicOrigin || '').trim();

  const loginTitle = String(input.loginTitle || companyName).trim();
  const shortName = String(input.shortName || appTitle).trim();
  const fullSystemName = String(input.fullSystemName || `${companyName} — ${appTitle}`).trim();

  return {
    companyName,
    appTitle,
    loginTitle,
    logoPath,
    logoAlt: String(input.logoAlt || `${companyName} — ${appTitle}`).trim(),
    primaryColor,
    primaryColorHover,
    backgroundColor,
    loginSubtitle: String(
      input.loginSubtitle || `${fullSystemName} · Control de accesos`
    ).trim(),
    headerSubtitle: String(
      input.headerSubtitle || `${fullSystemName} · Control de accesos y novedades`
    ).trim(),
    kioskTitle: String(input.kioskTitle || DEFAULTS.kioskTitle).trim(),
    kioskSubtitle: String(input.kioskSubtitle || DEFAULTS.kioskSubtitle).trim(),
    footerText: String(input.footerText || `${appTitle} — ${companyName}`).trim(),
    pdfReportTitle: String(
      input.pdfReportTitle || `Historial — ${appTitle} (${companyName})`
    ).trim(),
    pdfSummaryReportTitle: String(
      input.pdfSummaryReportTitle || `Reporte gerencial — ${appTitle} (${companyName})`
    ).trim(),
    metaDescription: String(
      input.metaDescription ||
        `${appTitle} — ${companyName.replace(/\.$/, '')}. Registro de personal, vehículos y novedades en planta.`
    ).trim(),
    shortName,
    themeStorageKey: String(input.themeStorageKey || `${slug}-theme`).trim(),
    loginUsernamePlaceholder: String(
      input.loginUsernamePlaceholder || DEFAULTS.loginUsernamePlaceholder
    ).trim(),
    publicOrigin,
    fullSystemName
  };
};

const renderBrandModule = (brand) => {
  const lines = Object.entries(brand).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
  return `/**
 * CONFIGURACIÓN DE MARCA — generada por scripts/scaffold-brand.js
 * No editar a mano salvo un ajuste puntual; preferí regenerar desde el JSON del cliente.
 */
const brand = {
${lines.join(',\n')}
};

module.exports = brand;
`;
};

module.exports = {
  REQUIRED_KEYS,
  DEFAULTS,
  slugify,
  normalizeHex,
  darkenHex,
  toPublicLogoPath,
  buildBrandConfig,
  renderBrandModule
};
