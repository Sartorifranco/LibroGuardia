/**
 * Coherencia hardware: modo offline del lector exige puerta relayMode=local.
 */

const OFFLINE_NEEDS_LOCAL_TITLE = 'Configuración incompatible';

const offlineNeedsLocalMessage = ({ doorName = 'esta puerta', context = 'lector' } = {}) => {
  const puerta = doorName || 'esta puerta';
  if (context === 'door') {
    return (
      `No se puede guardar “${puerta}” en modo A distancia mientras tenga lectores con Modo offline activo. `
      + 'Para online + cortes de red usá En planta en la puerta y Modo offline en el lector. '
      + 'Desactivá el offline de esos lectores o dejá la puerta en En planta.'
    );
  }
  return (
    `No se puede activar Modo offline: la puerta “${puerta}” está en A distancia. `
      + 'Para que funcione con y sin internet, la puerta debe estar En planta (mini PC abre por LAN) '
      + 'y recién ahí tildá Modo offline en el lector.'
  );
};

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const isLocalRelayMode = (relayMode) => String(relayMode || 'cloud') === 'local';

/**
 * Si offlineCache y la puerta no es local → 400.
 */
const assertOfflineCompatibleWithDoor = (door, { offlineCache, doorName } = {}) => {
  if (!offlineCache) return;
  if (isLocalRelayMode(door?.relayMode)) return;
  throw httpError(
    400,
    offlineNeedsLocalMessage({
      doorName: doorName || door?.name || door?.id || 'esta puerta',
      context: 'lector'
    }),
    'offline_requires_local_relay'
  );
};

/**
 * Al guardar puertas: ninguna puerta cloud puede tener lectores con offlineCache.
 * @param {Array} doors
 * @param {() => Promise<Array<{doorId:string,offlineCache?:boolean,nombre?:string}>>} listLectoresFn
 */
const assertDoorsCompatibleWithOfflineLectores = async (doors = [], listLectoresFn) => {
  const cloudDoorIds = new Set(
    (doors || [])
      .filter((d) => d && d.active !== false && !isLocalRelayMode(d.relayMode))
      .map((d) => d.id)
  );
  if (!cloudDoorIds.size || typeof listLectoresFn !== 'function') return;

  const lectores = await listLectoresFn();
  const blockers = (lectores || []).filter(
    (l) => l && l.offlineCache && cloudDoorIds.has(l.doorId)
  );
  if (!blockers.length) return;

  const byDoor = new Map();
  for (const l of blockers) {
    const list = byDoor.get(l.doorId) || [];
    list.push(l.nombre || l.id);
    byDoor.set(l.doorId, list);
  }
  const door = (doors || []).find((d) => byDoor.has(d.id));
  const names = byDoor.get(door?.id) || [];
  throw httpError(
    400,
    offlineNeedsLocalMessage({
      doorName: door?.name || door?.id || 'una puerta',
      context: 'door'
    }) + (names.length ? ` Lectores afectados: ${names.join(', ')}.` : ''),
    'cloud_relay_blocks_offline_lectores'
  );
};

module.exports = {
  OFFLINE_NEEDS_LOCAL_TITLE,
  offlineNeedsLocalMessage,
  isLocalRelayMode,
  assertOfflineCompatibleWithDoor,
  assertDoorsCompatibleWithOfflineLectores
};
