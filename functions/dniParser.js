const normalizeIdNumber = (value = '') => String(value).replace(/\D/g, '');

const buildFullName = (firstName = '', lastName = '') =>
  [firstName, lastName].map((part) => part.trim()).filter(Boolean).join(' ');

const parseArgentinePdf417 = (rawData = '') => {
  const trimmed = String(rawData).trim();
  if (!trimmed.includes('@')) return null;

  const parts = trimmed.split('@').map((part) => part.trim());
  if (parts.length < 5) return null;

  const [
    tramite,
    lastName,
    firstName,
    sex,
    idNumberRaw,
    ejemplar,
    birthDate,
    issueDate
  ] = parts;

  const idNumber = normalizeIdNumber(idNumberRaw);
  if (!idNumber || idNumber.length < 7) return null;

  return {
    format: 'pdf417',
    idNumber,
    firstName,
    lastName,
    name: buildFullName(firstName, lastName),
    sex: sex || '',
    tramite: tramite || '',
    ejemplar: ejemplar || '',
    birthDate: birthDate || '',
    issueDate: issueDate || '',
    rawData: trimmed
  };
};

const parseMrzLine = (line = '') => {
  const cleaned = line.replace(/\s/g, '').toUpperCase();
  const match = cleaned.match(/(\d{7,8})/);
  if (!match) return null;
  return {
    format: 'mrz',
    idNumber: match[1],
    name: '',
    rawData: line.trim()
  };
};

const parseScanData = (rawData = '') => {
  const trimmed = String(rawData).trim();
  if (!trimmed) return { idNumber: '', rawData: trimmed, format: 'empty' };

  const pdf417 = parseArgentinePdf417(trimmed);
  if (pdf417) return pdf417;

  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const mrz = parseMrzLine(line);
      if (mrz?.idNumber) return mrz;
      const linePdf = parseArgentinePdf417(line);
      if (linePdf) return linePdf;
    }
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.dni || parsed.idNumber || parsed.documento) {
      const firstName = parsed.nombre || parsed.firstName || '';
      const lastName = parsed.apellido || parsed.lastName || '';
      return {
        format: 'json',
        idNumber: normalizeIdNumber(parsed.dni || parsed.idNumber || parsed.documento),
        name: parsed.name || parsed.nombreCompleto || buildFullName(firstName, lastName),
        firstName,
        lastName,
        company: parsed.company || parsed.empresa || '',
        destination: parsed.destination || parsed.destino || parsed.area || '',
        rawData: trimmed
      };
    }
  } catch (_err) {
    // Not JSON.
  }

  const dniMatch = trimmed.match(/\b(\d{7,8})\b/);
  if (dniMatch) {
    return { format: 'numeric', idNumber: dniMatch[1], rawData: trimmed };
  }

  const digitsOnly = normalizeIdNumber(trimmed);
  if (digitsOnly.length >= 7 && digitsOnly.length <= 8) {
    return { format: 'numeric', idNumber: digitsOnly, rawData: trimmed };
  }

  return { format: 'unknown', idNumber: '', rawData: trimmed };
};

const dniFromToken = (token) => {
  const digits = String(token || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 8 ? digits : '';
};

/**
 * DNI de 7–8 dígitos dentro de una ficha (QR de credencial, no PDF417).
 * Prioriza una línea o campo etiquetado DNI / Documento / Doc.
 * Sin etiqueta, solo si hay un único número de 7–8 dígitos.
 * @returns {string} solo dígitos, o '' si no hay uno inequívoco
 */
const findEmbeddedDni = (raw = '') => {
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return '';

  const labeledRe = /(?<![A-Za-z])(?:documento|dni|doc)\.?(?![A-Za-z])\s*[#:=]?\s*(\d{1,2}(?:[.\s]\d{3}){2}|\d{7,8})(?!\d)/gi;
  const labeled = [];
  for (const match of text.matchAll(labeledRe)) {
    const dni = dniFromToken(match[1]);
    if (dni) labeled.push(dni);
  }
  if (labeled.length) return labeled[0];

  const bareRe = /(?<!\d)(\d{1,2}\.\d{3}\.\d{3})(?!\d)|(?<!\d)(\d{1,2} \d{3} \d{3})(?!\d)|\b(\d{7,8})\b/g;
  const bare = new Set();
  for (const match of text.matchAll(bareRe)) {
    const dni = dniFromToken(match[1] || match[2] || match[3]);
    if (dni) bare.add(dni);
  }
  if (bare.size === 1) return [...bare][0];
  return '';
};

module.exports = {
  normalizeIdNumber,
  parseScanData,
  parseArgentinePdf417,
  findEmbeddedDni
};
