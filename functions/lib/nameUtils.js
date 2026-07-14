const normalizePersonName = (value = '') =>
  String(value || '')
    .replace(/,/g, ' ')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const buildNameTokens = (value = '') =>
  normalizePersonName(value)
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .sort()
    .join(' ');

const namesMatch = (left, right) => {
  const a = buildNameTokens(left);
  const b = buildNameTokens(right);
  return Boolean(a && b && a === b);
};

module.exports = {
  normalizePersonName,
  buildNameTokens,
  namesMatch
};
