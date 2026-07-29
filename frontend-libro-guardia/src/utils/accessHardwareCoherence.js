/**
 * Coherencia hardware: modo offline del lector exige puerta "En planta".
 * A distancia abre por internet; sin red no hay camino a la placa.
 */

export const OFFLINE_NEEDS_LOCAL_RELAY_TITLE = 'Configuración incompatible';

export const offlineNeedsLocalRelayMessage = ({
  doorName = 'esta puerta',
  context = 'lector'
} = {}) => {
  const puerta = doorName || 'esta puerta';
  if (context === 'door') {
    return (
      `No podés poner “${puerta}” en modo A distancia mientras tenga lectores con Modo offline activo.\n\n`
      + 'Para que funcione con internet y también sin internet, la puerta debe estar en En planta '
      + '(la mini PC abre el relé por la red local) y el lector con Modo offline tildado.\n\n'
      + 'Primero desactivá el Modo offline en esos lectores, o dejá la puerta en En planta.'
    );
  }
  return (
    `No podés activar Modo offline en un lector de “${puerta}” porque esa puerta está en A distancia.\n\n`
    + 'Configuración correcta para online + cortes de red:\n'
    + '1) Puerta → En planta (+ placa SR201)\n'
    + '2) Lector → Modo offline (caché local) tildado\n\n'
    + 'A distancia sirve para abrir desde internet, pero sin internet no llega a la placa. '
    + 'Cambiá la puerta a En planta y después activá el offline.'
  );
};

export const isLocalRelayMode = (relayMode) => String(relayMode || 'cloud') === 'local';

/**
 * @returns {null|{ title: string, message: string }}
 */
export const checkOfflineWithDoorRelay = ({
  offlineCache,
  doorRelayMode,
  doorName,
  context = 'lector'
} = {}) => {
  if (!offlineCache) return null;
  if (isLocalRelayMode(doorRelayMode)) return null;
  return {
    title: OFFLINE_NEEDS_LOCAL_RELAY_TITLE,
    message: offlineNeedsLocalRelayMessage({ doorName, context })
  };
};

export default {
  OFFLINE_NEEDS_LOCAL_RELAY_TITLE,
  offlineNeedsLocalRelayMessage,
  isLocalRelayMode,
  checkOfflineWithDoorRelay
};
