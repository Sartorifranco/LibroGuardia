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

export function airlockPartnerId(doorId, groups = []) {
  const group = (groups || []).find((item) => (item.doorIds || []).includes(doorId) && item.enabled !== false);
  if (!group) return '';
  return (group.doorIds || []).find((id) => id && id !== doorId) || '';
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
  if (draft.airlockEnabled === true) {
    if (!draft.airlockPartnerId) {
      errors.airlockPartnerId = 'Elegí la otra puerta. En un estanco nunca se abren las dos a la vez.';
    } else if (draft.airlockPartnerId === draft.id) {
      errors.airlockPartnerId = 'Una puerta no puede formar un estanco consigo misma.';
    }
  }
  return errors;
}

/**
 * Arma los grupos de estanco a partir de la elección del formulario.
 * La puerta editada queda del lado de afuera si toca el exterior o es un portón.
 * La pareja anterior sale del estanco.
 */
export function applyAirlockChoice(doors = [], groups = [], draft = {}) {
  const selfId = String(draft.id || '').trim();
  const wantPair = draft.airlockEnabled === true && draft.airlockPartnerId && draft.airlockPartnerId !== selfId;
  const partnerId = wantPair ? String(draft.airlockPartnerId).trim() : '';
  const removed = new Set([selfId]);
  if (partnerId) removed.add(partnerId);

  let nextGroups = (groups || []).map((group) => ({
    ...group,
    doorIds: (group.doorIds || []).filter((id) => !removed.has(id))
  })).filter((group) => group.doorIds.length >= 2);

  const assignment = new Map();
  if (wantPair) {
    const groupId = `estanco-${[selfId, partnerId].slice().sort().join('-')}`.slice(0, 48);
    nextGroups = nextGroups.filter((group) => group.id !== groupId);
    nextGroups.push({
      id: groupId,
      name: `Estanco ${String(draft.name || selfId).trim()}`,
      doorIds: [selfId, partnerId],
      enabled: true,
      mode: 'sequential_closed'
    });
    const selfIsOuter = draft.placeA === 'exterior' || draft.placeB === 'exterior' || draft.kind === 'gate';
    assignment.set(selfId, { airlockGroupId: groupId, airlockRole: selfIsOuter ? 'outer' : 'inner' });
    assignment.set(partnerId, { airlockGroupId: groupId, airlockRole: selfIsOuter ? 'inner' : 'outer' });
  }

  const nextDoors = doors.map((door) => {
    if (assignment.has(door.id)) return { ...door, ...assignment.get(door.id) };
    const still = nextGroups.some((group) => (group.doorIds || []).includes(door.id));
    if (!still && door.airlockGroupId) return { ...door, airlockGroupId: null, airlockRole: null };
    return door;
  });

  return { doors: nextDoors, airlockGroups: nextGroups };
}
