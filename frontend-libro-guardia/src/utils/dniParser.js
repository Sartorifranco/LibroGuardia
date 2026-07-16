const normalizeIdNumber = (value = '') => String(value).replace(/\D/g, '');

const buildFullName = (firstName = '', lastName = '') =>
  [firstName, lastName].map((part) => part.trim()).filter(Boolean).join(' ');

const parseArgentinePdf417 = (rawData = '') => {
  const trimmed = String(rawData).trim();
  if (!trimmed.includes('@')) return null;

  const parts = trimmed.split('@').map((part) => part.trim());
  if (parts.length < 5) return null;

  const [, lastName, firstName, , idNumberRaw] = parts;
  const idNumber = normalizeIdNumber(idNumberRaw);
  if (!idNumber || idNumber.length < 7) return null;

  return {
    format: 'pdf417',
    idNumber,
    firstName,
    lastName,
    name: buildFullName(firstName, lastName)
  };
};

export const parseScanData = (rawData = '') => {
  const trimmed = String(rawData).trim();
  if (!trimmed) return { idNumber: '', name: '', format: 'empty' };

  const pdf417 = parseArgentinePdf417(trimmed);
  if (pdf417) return pdf417;

  const dniMatch = trimmed.match(/\b(\d{7,8})\b/);
  if (dniMatch) {
    return { format: 'numeric', idNumber: dniMatch[1], name: '' };
  }

  const digitsOnly = normalizeIdNumber(trimmed);
  if (digitsOnly.length >= 7 && digitsOnly.length <= 8) {
    return { format: 'numeric', idNumber: digitsOnly, name: '' };
  }

  return { format: 'unknown', idNumber: '', name: '' };
};

export { normalizeIdNumber };
