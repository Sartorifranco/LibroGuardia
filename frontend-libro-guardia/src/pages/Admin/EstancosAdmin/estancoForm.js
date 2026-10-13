/** Estancos: grupos de 2 o más puertas donde nunca se abren dos a la vez. */

const slugify = (value = '') => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

/** "A", "A y B", "A, B y C". Antes de una palabra que suena con i va "e". */
export function joinNames(names = []) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  const last = list[list.length - 1];
  const joiner = /^h?i(?![aeiou])/i.test(String(last).trim()) ? ' e ' : ' y ';
  return `${list.slice(0, -1).join(', ')}${joiner}${last}`;
}

export function airlockGroupsOfDoor(doorId, groups = []) {
  if (!doorId) return [];
  return (groups || []).filter((group) => (group.doorIds || []).includes(doorId));
}

/** Una línea por estanco: "Estanco Guardia (con Puerta A y Puerta B)". */
export function describeDoorAirlocks(doorId, groups = [], doors = []) {
  const nameOf = (id) => doors.find((door) => door.id === id)?.name || id;
  return airlockGroupsOfDoor(doorId, groups).map((group) => {
    const others = (group.doorIds || []).filter((id) => id !== doorId).map(nameOf);
    return others.length ? `${group.name || group.id} (con ${joinNames(others)})` : (group.name || group.id);
  });
}

/** airlockGroupId = primer estanco que la contiene; airlockRole = 'outer' si es la de afuera de ese estanco. */
export function syncAirlockFields(doors = [], groups = []) {
  return doors.map((door) => {
    const group = airlockGroupsOfDoor(door.id, groups)[0];
    const airlockGroupId = group ? group.id : null;
    const airlockRole = group ? (group.outerDoorId === door.id ? 'outer' : 'inner') : null;
    if ((door.airlockGroupId || null) === airlockGroupId && (door.airlockRole || null) === airlockRole) return door;
    return { ...door, airlockGroupId, airlockRole };
  });
}

/**
 * Saca una puerta de todos los estancos. Los que quedan con menos de 2 puertas se borran.
 * Si era la de afuera, pasa a serlo la primera que queda.
 */
export function removeDoorFromGroups(doorId, groups = []) {
  const removed = [];
  const changedOuter = [];
  const next = [];
  (groups || []).forEach((group) => {
    if (!(group.doorIds || []).includes(doorId)) {
      next.push(group);
      return;
    }
    const doorIds = group.doorIds.filter((id) => id !== doorId);
    if (doorIds.length < 2) {
      removed.push(group);
      return;
    }
    const lostOuter = group.outerDoorId === doorId;
    if (lostOuter) changedOuter.push(group);
    next.push({ ...group, doorIds, outerDoorId: lostOuter ? doorIds[0] : group.outerDoorId });
  });
  return { airlockGroups: next, removed, changedOuter };
}

/**
 * @param {{ id?: string, name: string, doorIds: string[], outerDoorId: string }} draft
 * @returns {Record<string, string>} vacío si se puede guardar
 */
export function validateAirlockGroup(draft = {}, groups = []) {
  const errors = {};
  const name = String(draft.name || '').trim();
  if (name.length < 2) {
    errors.name = 'Escribí un nombre de al menos 2 letras. Por ejemplo, Estanco Guardia.';
  } else if ((groups || []).some((group) => group.id !== draft.id
    && String(group.name || '').trim().toLowerCase() === name.toLowerCase())) {
    errors.name = 'Ya hay un estanco con ese nombre. Usá otro.';
  }
  const doorIds = Array.isArray(draft.doorIds) ? draft.doorIds.filter(Boolean) : [];
  if (doorIds.length < 2) {
    errors.doorIds = 'Marcá al menos 2 puertas. Un estanco siempre tiene 2 puertas o más.';
  }
  if (!draft.outerDoorId || !doorIds.includes(draft.outerDoorId)) {
    errors.outerDoorId = 'Elegí cuál de las puertas marcadas es la de afuera.';
  }
  return errors;
}

/** Arma el estanco listo para guardar. La puerta de afuera va primera; el resto, en el orden de la lista de puertas. */
export function buildAirlockGroup(draft = {}, groups = [], doors = []) {
  const chosen = new Set((draft.doorIds || []).filter(Boolean));
  const ordered = doors.map((door) => door.id).filter((id) => chosen.has(id));
  chosen.forEach((id) => { if (!ordered.includes(id)) ordered.push(id); });
  const doorIds = [draft.outerDoorId, ...ordered.filter((id) => id !== draft.outerDoorId)];
  const existing = (groups || []).find((group) => group.id === draft.id);
  let id = existing?.id;
  if (!id) {
    const named = slugify(draft.name);
    const base = (named.startsWith('estanco') ? named : slugify(`estanco-${draft.name}`)) || 'estanco';
    const used = new Set((groups || []).map((group) => group.id));
    id = base;
    let n = 2;
    while (used.has(id)) { id = `${base}-${n}`; n += 1; }
  }
  return {
    ...(existing || {}),
    id,
    name: String(draft.name || '').trim(),
    doorIds,
    outerDoorId: draft.outerDoorId,
    enabled: existing ? existing.enabled !== false : true,
    mode: 'sequential_closed'
  };
}

/** Reemplaza o agrega el estanco, sin tocar los demás. */
export function upsertAirlockGroup(groups = [], group) {
  const exists = (groups || []).some((item) => item.id === group.id);
  return exists
    ? groups.map((item) => (item.id === group.id ? group : item))
    : [...(groups || []), group];
}
