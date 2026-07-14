const { stripAccents } = require('./normalize');

/** Áreas donde la planilla diaria de citaciones define quién ingresa. */
const CITACION_REQUIRED_AREA_KEYS = new Set(['transporte', 'tesoreria']);

const isCitacionRequiredArea = (centroCosto = '') =>
  CITACION_REQUIRED_AREA_KEYS.has(getAreaKey(centroCosto));

const isSistemasArea = (centroCosto = '') => getAreaKey(centroCosto) === 'sistemas';

const isGruasArea = (centroCosto = '') => getAreaKey(centroCosto) === 'gruas';

const AREA_ALIASES = {
  transporte: 'Transporte',
  tesoreria: 'Tesorería',
  sistemas: 'Sistemas',
  administracion: 'Administración',
  'capital humano': 'Capital Humano',
  'seguridad planta': 'Seguridad',
  'oficina seguridad planta': 'Seguridad',
  comercial: 'Comercial',
  finanzas: 'Finanzas',
  marketing: 'Marketing',
  veedores: 'Veedores',
  'compras y mantenimi': 'Compras y Mant.',
  'sala de armas': 'Sala de Armas',
  personal: 'Personal',
  gruas: 'Grúas'
};

const PREFIX_ALIASES = [
  ['administraci', 'Administración'],
  ['compras y mantenimi', 'Compras y Mant.'],
  ['oficina seguridad p', 'Seguridad'],
  ['seguridad planta', 'Seguridad']
];

const normalizeAreaKey = (value = '') =>
  stripAccents(String(value || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const resolveTruncatedLabel = (key = '') => {
  const match = PREFIX_ALIASES.find(([prefix]) => key.startsWith(prefix));
  return match ? match[1] : null;
};

const titleCase = (value = '') =>
  String(value || '')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

const extractAreaShort = (centroCosto = '') => {
  const raw = String(centroCosto || '').trim();
  if (!raw) return 'Sin área';

  const firstSegment = raw.split(',')[0].trim();
  const dashParts = firstSegment.split(/\s+-\s+/);

  if (dashParts.length >= 2) {
    const org = normalizeAreaKey(dashParts[0]);
    if (org === 'gruas') return 'Grúas';
  }

  let candidate = dashParts.length >= 2
    ? dashParts[dashParts.length - 1].trim()
    : firstSegment;

  candidate = candidate.replace(/,\s*[A-Z]$/i, '').trim();
  if (!candidate) candidate = firstSegment;

  const key = normalizeAreaKey(candidate);
  if (AREA_ALIASES[key]) return AREA_ALIASES[key];

  const truncated = resolveTruncatedLabel(key);
  if (truncated) return truncated;

  const aliasEntry = Object.entries(AREA_ALIASES).find(([alias]) => key.includes(alias) || alias.includes(key));
  if (aliasEntry) return aliasEntry[1];

  return titleCase(candidate);
};

const getAreaKey = (centroCosto = '') => {
  const short = extractAreaShort(centroCosto);
  if (short === 'Sin área') return '__empty__';
  return normalizeAreaKey(short);
};

const buildAreaGroups = (items = [], centroField = 'centroCosto') => {
  const map = new Map();

  items.forEach((item) => {
    const centro = item[centroField] || '';
    const key = getAreaKey(centro);
    const label = extractAreaShort(centro);
    const existing = map.get(key) || { key, label, count: 0 };
    existing.count += 1;
    map.set(key, existing);
  });

  return [...map.values()].sort((a, b) => {
    if (a.key === '__empty__') return 1;
    if (b.key === '__empty__') return -1;
    return a.label.localeCompare(b.label, 'es');
  });
};

const buildAttendanceAreaSummary = (allEmployees = [], roster = []) => {
  const nominaGroups = buildAreaGroups(
    allEmployees.map((employee) => ({
      centroCosto: employee.centroCosto || employee.company || ''
    }))
  );

  const rosterStats = new Map();
  roster.forEach((item) => {
    const key = item.areaKey || getAreaKey(item.centroCosto);
    const bucket = rosterStats.get(key) || {
      expectedToday: 0,
      presentToday: 0,
      missingToday: 0
    };
    bucket.expectedToday += 1;
    if (item.status === 'present') bucket.presentToday += 1;
    if (item.status === 'missing') bucket.missingToday += 1;
    rosterStats.set(key, bucket);
  });

  return nominaGroups
    .map((group) => {
      const stats = rosterStats.get(group.key) || {
        expectedToday: 0,
        presentToday: 0,
        missingToday: 0
      };
      return {
        key: group.key,
        label: group.label,
        totalInNomina: group.count,
        expectedToday: stats.expectedToday,
        presentToday: stats.presentToday,
        missingToday: stats.missingToday
      };
    })
    .filter((area) => area.expectedToday > 0);
};

module.exports = {
  extractAreaShort,
  getAreaKey,
  normalizeAreaKey,
  buildAreaGroups,
  buildAttendanceAreaSummary,
  isCitacionRequiredArea,
  isSistemasArea,
  isGruasArea,
  CITACION_REQUIRED_AREA_KEYS,
  AREA_ALIASES
};
