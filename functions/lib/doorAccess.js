/**
 * Restricción de ingreso por puerta (lista individual por persona/autorización/visita).
 *
 * Semántica GLOBAL de allowedDoorIds (permanente, no configurable por puerta):
 * - null / undefined / campo ausente / []  →  NINGUNA puerta (rechazo)
 * - array con ≥1 doorId  →  SOLO esas puertas
 *
 * Si no hay doorId en el contexto (p.ej. evaluación sin puerta), no se aplica
 * la restricción (no hay puerta concreta que validar).
 */

const normalizeAllowedDoorIds = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || '').trim()).filter(Boolean))];
};

/** true si el ingreso por doorId está permitido según la lista. */
const isDoorAllowedForIngreso = (allowedDoorIds, doorId) => {
  const door = String(doorId || '').trim();
  // Sin puerta concreta no hay restricción que aplicar.
  if (!door) return true;
  const list = normalizeAllowedDoorIds(allowedDoorIds);
  if (!list.length) return false;
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

/** Agrega doorId a la lista (null/[] → [doorId]). */
const addDoorToAllowedList = (current, doorId) => {
  const door = String(doorId || '').trim();
  if (!door) return normalizeAllowedDoorIds(current);
  const list = normalizeAllowedDoorIds(current);
  if (list.includes(door)) return list;
  return [...list, door];
};

/** Quita doorId; si la lista queda vacía → [] (ninguna puerta). */
const removeDoorFromAllowedList = (current, doorId) => {
  const door = String(doorId || '').trim();
  const list = normalizeAllowedDoorIds(current);
  if (!door) return list;
  return list.filter((id) => id !== door);
};

module.exports = {
  normalizeAllowedDoorIds,
  isDoorAllowedForIngreso,
  applyDoorRestrictionForIngreso,
  addDoorToAllowedList,
  removeDoorFromAllowedList
};
