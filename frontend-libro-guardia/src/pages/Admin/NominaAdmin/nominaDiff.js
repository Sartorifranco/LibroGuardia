function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function pickField(row, pattern) {
  if (!row || typeof row !== 'object') return '';
  const key = Object.keys(row).find((name) => pattern.test(String(name)));
  return key ? row[key] : '';
}

function nameKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function dniOfIncoming(row) {
  return digits(pickField(row, /dni/i));
}

function nameOfIncoming(row) {
  const usuario = String(pickField(row, /^usuario$/i) || '').trim();
  if (usuario) return usuario;
  const apellido = String(pickField(row, /apellido/i) || '').trim();
  const nombreKey = Object.keys(row || {}).find((name) => /^nombre$/i.test(String(name)));
  const nombre = String((nombreKey ? row[nombreKey] : '') || '').trim();
  return `${apellido} ${nombre}`.trim();
}

/**
 * Compara la nómina activa con las filas de la planilla.
 * @param {Array<{ active?: boolean, name?: string, idNumber?: string, idNumberNormalized?: string }>} currentPeople
 * @param {Array<Record<string, unknown>>} incomingRows
 * @returns {{ altas: number, bajas: number, cambios: number, sinDni: number }}
 */
export function summarizeNominaChange(currentPeople, incomingRows) {
  const current = new Map();
  (currentPeople || []).forEach((person) => {
    if (!person || person.active === false) return;
    const dni = digits(person.idNumberNormalized || person.idNumber);
    if (!dni) return;
    current.set(dni, nameKey(person.name));
  });

  const incoming = new Map();
  let sinDni = 0;
  (incomingRows || []).forEach((row) => {
    const dni = dniOfIncoming(row);
    if (!dni) {
      sinDni += 1;
      return;
    }
    incoming.set(dni, nameKey(nameOfIncoming(row)));
  });

  let altas = 0;
  let cambios = 0;
  incoming.forEach((name, dni) => {
    if (!current.has(dni)) altas += 1;
    else if (name && current.get(dni) && name !== current.get(dni)) cambios += 1;
  });

  let bajas = 0;
  current.forEach((_, dni) => {
    if (!incoming.has(dni)) bajas += 1;
  });

  return { altas, bajas, cambios, sinDni };
}
