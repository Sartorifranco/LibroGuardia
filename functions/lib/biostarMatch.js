/**
 * Extracción de DNI / match helpers para import BioStar.
 */

const { normalizeIdNumber } = require('../dniParser');
const { buildNameTokens } = require('./nameUtils');

/** DNI argentino típico: 7–8 dígitos. */
const looksLikeDni = (digits = '') => {
  const d = String(digits || '').replace(/\D/g, '');
  return d.length >= 7 && d.length <= 8;
};

const pushCandidate = (list, raw, source) => {
  const digits = normalizeIdNumber(raw);
  if (!looksLikeDni(digits)) return;
  if (list.some((c) => c.dni === digits)) return;
  list.push({ dni: digits, source });
};

/**
 * Candidatos a DNI desde una fila User de BioStar.
 */
const extractBiostarDniCandidates = (raw = {}) => {
  const list = [];
  pushCandidate(list, raw.user_id || raw.userId, 'user_id');
  pushCandidate(list, raw.login_id || raw.loginId, 'login_id');
  pushCandidate(list, raw.email, 'email');

  const name = String(raw.name || '').trim();
  const nameDigits = name.match(/\d{7,8}/g) || [];
  nameDigits.forEach((d) => pushCandidate(list, d, 'name_digits'));

  // Campos custom frecuentes
  Object.keys(raw || {}).forEach((key) => {
    if (!/custom|user_title|department|phone|employee|documento|dni/i.test(key)) return;
    const val = raw[key];
    if (val == null || typeof val === 'object') return;
    pushCandidate(list, val, key);
  });

  return list;
};

const biostarDisplayName = (raw = {}, userId = '') => {
  const name = String(raw.name || '').trim();
  if (name && !/^\d+$/.test(name)) return name;
  return userId ? `BioStar ${userId}` : 'BioStar';
};

module.exports = {
  looksLikeDni,
  extractBiostarDniCandidates,
  biostarDisplayName,
  buildNameTokens
};
