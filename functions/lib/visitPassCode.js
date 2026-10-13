/**
 * Código de pase de visita (contenido del QR): `MSSV1.` + 128 bits aleatorios en hex
 * mayúscula. Es opaco: no lleva nombre ni DNI. El borde lo busca por id en visitorPasses.
 */

const crypto = require('crypto');

const PASS_CODE_PREFIX = 'MSSV1.';
const PASS_CODE_RE = /^MSSV1\.[0-9A-F]{32}$/;

const generatePassCode = () => `${PASS_CODE_PREFIX}${crypto.randomBytes(16).toString('hex').toUpperCase()}`;

/** Forma canónica del código o null si el formato no es válido. */
const parsePassCode = (raw) => {
  const value = String(raw == null ? '' : raw).trim().toUpperCase();
  return PASS_CODE_RE.test(value) ? value : null;
};

const isValidPassCode = (raw) => parsePassCode(raw) !== null;

/** true si empieza con el prefijo (aunque esté mal formado): nunca tratarlo como DNI. */
const looksLikePassCode = (raw) => String(raw == null ? '' : raw).trim().toUpperCase().startsWith(PASS_CODE_PREFIX);

module.exports = {
  PASS_CODE_PREFIX,
  generatePassCode,
  parsePassCode,
  isValidPassCode,
  looksLikePassCode
};
