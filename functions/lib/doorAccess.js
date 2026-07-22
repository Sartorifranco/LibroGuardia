/**
 * Restricción de ingreso por puerta (lista individual por persona/autorización).
 *
 * Semántica de allowedDoorIds:
 * - null / undefined / campo ausente / []  →  TODAS las puertas (sin restricción)
 * - array con ≥1 doorId  →  SOLO esas puertas
 *
 * Motivo: las personas ya cargadas no tienen el campo; tratar vacío/ausente como
 * "todas" preserva el comportamiento actual sin migración masiva. La UI de
 * "Solo estas puertas" siempre guarda un array no vacío.
 */

const normalizeAllowedDoorIds = (value) => {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map((id) => String(id || '').trim()).filter(Boolean))];
  return ids.length ? ids : null;
};

/** true si el ingreso por doorId está permitido según la lista. */
const isDoorAllowedForIngreso = (allowedDoorIds, doorId) => {
  const door = String(doorId || '').trim();
  if (!door) return true;
  const list = normalizeAllowedDoorIds(allowedDoorIds);
  if (!list) return true;
  return list.includes(door);
};

/**
 * Aplica restricción de puerta solo a ingresos ya autorizados.
 * No altera egresos ni denegaciones previas.
 */
const applyDoorRestrictionForIngreso = ({
  authorized,
  denialReason = null,
  message = null,
  allowedDoorIds,
  doorId,
  movementType = 'ingreso'
} = {}) => {
  if (movementType === 'egreso') {
    return { authorized, denialReason, message };
  }
  if (!authorized) {
    return { authorized, denialReason, message };
  }
  if (isDoorAllowedForIngreso(allowedDoorIds, doorId)) {
    return { authorized, denialReason, message };
  }
  return {
    authorized: false,
    denialReason: 'puerta_no_autorizada',
    message: 'No autorizado para esta puerta'
  };
};

/** Agrega doorId a la lista; si era “todas”, pasa a [doorId] (modo restringido). */
const addDoorToAllowedList = (current, doorId) => {
  const door = String(doorId || '').trim();
  if (!door) return normalizeAllowedDoorIds(current);
  const list = normalizeAllowedDoorIds(current);
  if (!list) return [door];
  if (list.includes(door)) return list;
  return [...list, door];
};

/** Quita doorId; si la lista queda vacía → null (todas de nuevo). */
const removeDoorFromAllowedList = (current, doorId) => {
  const door = String(doorId || '').trim();
  const list = normalizeAllowedDoorIds(current);
  if (!list) return null;
  return normalizeAllowedDoorIds(list.filter((id) => id !== door));
};

module.exports = {
  normalizeAllowedDoorIds,
  isDoorAllowedForIngreso,
  applyDoorRestrictionForIngreso,
  addDoorToAllowedList,
  removeDoorFromAllowedList
};
