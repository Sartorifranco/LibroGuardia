/** Texto y validación del formulario simple de una puerta. */

export const DOOR_KINDS = [
  { id: 'door', label: 'Puerta' },
  { id: 'gate', label: 'Portón' },
  { id: 'turnstile', label: 'Molinete' }
];

export const kindLabel = (kind) => DOOR_KINDS.find((item) => item.id === kind)?.label || 'Puerta';

export function sidesFromPlaces(placeA, placeB) {
  const from = String(placeA || '').trim();
  const to = String(placeB || '').trim();
  if (!from || !to) return null;
  return {
    in: { zoneFrom: from, zoneTo: to },
    out: { zoneFrom: to, zoneTo: from }
  };
}

export function placesFromDoor(door = {}) {
  const inn = door.sides && door.sides.in ? door.sides.in : {};
  return {
    placeA: inn.zoneFrom || '',
    placeB: inn.zoneTo || ''
  };
}

/** Falta un lado, o los dos son el mismo lugar. */
export function placesNeedChoice(placeA, placeB) {
  const from = String(placeA || '').trim();
  const to = String(placeB || '').trim();
  return !from || !to || from === to;
}

export function swapPlaces(placeA, placeB) {
  return {
    placeA: placeB || '',
    placeB: placeA || ''
  };
}

/** 'outside' = solo el lector de afuera. 'both' = afuera y adentro (recomendado). */
export function readersModeOf(door = {}) {
  if (door.readersMode === 'outside' || door.readersMode === 'both') return door.readersMode;
  const readers = Array.isArray(door.readers) ? door.readers : [];
  const hasOut = readers.some((reader) => reader?.side === 'out' || reader?.direction === 'egreso');
  const hasIn = readers.some((reader) => reader?.side === 'in' || reader?.direction === 'ingreso');
  if (hasOut) return 'both';
  if (hasIn) return 'outside';
  return 'both';
}

/** Arma los lectores con side in/out según el modo elegido. */
export function readersForDraft(draft = {}) {
  const code = String(draft.doorCode || 'P1').toUpperCase() || 'P1';
  const current = Array.isArray(draft.readers) ? draft.readers : [];
  const ingreso = current.find((reader) => reader?.side === 'in' || reader?.direction === 'ingreso');
  const egreso = current.find((reader) => reader?.side === 'out' || reader?.direction === 'egreso');
  const mode = readersModeOf(draft);
  const inn = {
    id: String(ingreso?.id || `INGRESO_${code}`).trim() || `INGRESO_${code}`,
    direction: 'ingreso',
    side: 'in'
  };
  if (mode === 'outside') return [inn];
  return [
    inn,
    {
      id: String(egreso?.id || `EGRESO_${code}`).trim() || `EGRESO_${code}`,
      direction: 'egreso',
      side: 'out'
    }
  ];
}

/**
 * @returns {Record<string, string>} vacío si se puede guardar
 */
export function validateSimpleDoor(draft = {}) {
  const errors = {};
  const name = String(draft.name || '').trim();
  if (name.length < 2) {
    errors.name = 'Escribí un nombre de al menos 2 letras. Por ejemplo, Portón de clientes.';
  }
  if (!DOOR_KINDS.some((item) => item.id === draft.kind)) {
    errors.kind = 'Elegí si es una puerta, un portón o un molinete.';
  }
  if (!draft.placeA) errors.placeA = 'Elegí desde dónde se llega a esta puerta.';
  if (!draft.placeB) errors.placeB = 'Elegí a qué lugar se entra al pasarla.';
  if (draft.placeA && draft.placeB && draft.placeA === draft.placeB) {
    errors.placeB = 'Los dos lados tienen que ser lugares distintos.';
  }
  const seconds = Number(draft.pulseSeconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
    errors.pulseSeconds = 'Poné entre 1 y 60 segundos. Con 3 alcanza para una puerta común.';
  }
  if (draft.sensorsRequired === true) {
    const held = Number(draft.heldOpenSec);
    if (!Number.isFinite(held) || held < 10 || held > 600) {
      errors.heldOpenSec = 'Poné entre 10 y 600 segundos. 60 es un buen aviso si queda abierta.';
    } else if (Number.isFinite(seconds) && held < seconds) {
      errors.heldOpenSec = 'El aviso tiene que ser más largo que el tiempo que queda destrabada.';
    }
  }
  return errors;
}
