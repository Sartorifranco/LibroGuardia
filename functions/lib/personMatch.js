const { normalizeIdNumber } = require('../dniParser');
const { buildNameTokens, namesMatch } = require('./nameUtils');

const normalizeLegajo = (value = '') => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits) return String(Number.parseInt(digits, 10));
  return raw.toLowerCase();
};

const tokenizeName = (name = '') =>
  buildNameTokens(name)
    .split(/\s+/)
    .filter(Boolean);

const fuzzyNameMatch = (leftName = '', rightName = '') => {
  if (namesMatch(leftName, rightName)) return true;

  const left = tokenizeName(leftName);
  const right = tokenizeName(rightName);
  if (left.length < 2 || right.length < 2) return false;
  if (left[0] !== right[0]) return false;

  const overlap = left.filter((token) => right.includes(token)).length;
  const minOverlap = Math.min(2, Math.min(left.length, right.length));
  return overlap >= minOverlap;
};

const addLegajoToIndex = (map, legajoRaw, employee) => {
  const raw = String(legajoRaw ?? '').trim();
  if (!raw) return;

  map.set(raw, employee);
  map.set(raw.toLowerCase(), employee);

  const normalized = normalizeLegajo(raw);
  if (normalized) map.set(normalized, employee);

  const digits = raw.replace(/\D/g, '');
  if (digits && digits !== raw) {
    map.set(digits, employee);
    const parsed = normalizeLegajo(digits);
    if (parsed) map.set(parsed, employee);
  }
};

const buildNominaEmployeeIndex = (employees = []) => {
  const byLegajo = new Map();
  const byDni = new Map();
  const byNameKey = new Map();
  const byPersonId = new Map();
  const list = [];

  employees.forEach((employee) => {
    if (employee.active === false) return;

    list.push(employee);

    addLegajoToIndex(byLegajo, employee.legajoNormalized || employee.legajo, employee);

    const dni = employee.idNumberNormalized || normalizeIdNumber(employee.idNumber);
    if (dni) byDni.set(dni, employee);

    const nameKey = employee.nameKey || buildNameTokens(employee.name);
    if (nameKey) byNameKey.set(nameKey, employee);

    if (employee.personId) byPersonId.set(employee.personId, employee);
  });

  return { byLegajo, byDni, byNameKey, byPersonId, list };
};

const matchCitacionToEmployee = (citacion = {}, index = {}) => {
  const { byLegajo, byDni, byNameKey, byPersonId, list } = index;

  if (citacion.personId && byPersonId?.has(citacion.personId)) {
    return byPersonId.get(citacion.personId);
  }

  const legajoCandidates = [
    citacion.legajoNormalized,
    citacion.legajo,
    citacion.notes?.match(/legajo[:\s]+(\d+)/i)?.[1]
  ].filter(Boolean);

  for (const candidate of legajoCandidates) {
    const raw = String(candidate).trim();
    const normalized = normalizeLegajo(raw);
    if (raw && byLegajo?.has(raw)) return byLegajo.get(raw);
    if (raw && byLegajo?.has(raw.toLowerCase())) return byLegajo.get(raw.toLowerCase());
    if (normalized && byLegajo?.has(normalized)) return byLegajo.get(normalized);
  }

  const dni = citacion.idNumberNormalized || normalizeIdNumber(citacion.idNumber);
  if (dni && byDni?.has(dni)) return byDni.get(dni);

  const nameKey = citacion.nameKey || citacion.nameTokens || buildNameTokens(citacion.name);
  if (nameKey && byNameKey?.has(nameKey)) return byNameKey.get(nameKey);

  if (citacion.name && list?.length) {
    const direct = list.find((employee) => fuzzyNameMatch(citacion.name, employee.name));
    if (direct) return direct;
  }

  return null;
};

const enrichCitacionFromMaster = (citacionRow = {}, master = null) => {
  if (!master) return citacionRow;

  return {
    ...citacionRow,
    legajo: master.legajoNormalized || master.legajo || citacionRow.legajo,
    idNumber: master.idNumberNormalized || master.idNumber || citacionRow.idNumber,
    name: master.name || citacionRow.name
  };
};

const findMasterForCitacionRow = (row = {}, lookups = {}) => {
  const { masterByLegajo, masterByNameKey, masterList } = lookups;

  const legajoRaw = String(row.legajo || '').trim();
  const legajoNorm = normalizeLegajo(legajoRaw);
  if (legajoRaw && masterByLegajo?.[legajoRaw]) return masterByLegajo[legajoRaw];
  if (legajoNorm && masterByLegajo?.[legajoNorm]) return masterByLegajo[legajoNorm];

  const nameKey = buildNameTokens(row.name);
  if (nameKey && masterByNameKey?.[nameKey]) return masterByNameKey[nameKey];

  if (row.name && masterList?.length) {
    return masterList.find((employee) => fuzzyNameMatch(row.name, employee.name)) || null;
  }

  return null;
};

module.exports = {
  normalizeLegajo,
  fuzzyNameMatch,
  buildNominaEmployeeIndex,
  matchCitacionToEmployee,
  enrichCitacionFromMaster,
  findMasterForCitacionRow
};
