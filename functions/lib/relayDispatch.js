/**
 * Decisión de disparo de relé para lecturas de kiosk / door-reader-bridge.
 *
 * Módulo PURO (sin Firestore ni red) → fácil de testear y reutilizable tanto
 * por la nube (accessControl.processKioskScan) como por el bridge de planta.
 *
 * relayMode por puerta:
 *   'cloud' (default) → la Cloud Function dispara el relé ella misma (driver/túnel).
 *   'local'           → la nube NO dispara; sólo decide autorización y devuelve
 *                       host/puerto/canal/pulseSeconds para que el bridge de la
 *                       propia puerta abra el relé directo por la LAN.
 */

const RELAY_MODES = ['cloud', 'local'];

/**
 * Misma condición que usaba processKioskScan inline (shouldTryRelay):
 * sólo intentamos abrir el relé en ingresos autorizados, con control de acceso
 * habilitado, triggerOn ingreso, la puerta con autoOpenOnAuth y sin ser guard-desk.
 */
const shouldAttemptRelay = ({
  isGuardDesk = false,
  movementType,
  authorized,
  config = {},
  door = {}
} = {}) =>
  !isGuardDesk
  && movementType === 'ingreso'
  && authorized === true
  && Boolean(config.enabled)
  && config.triggerOn === 'ingreso'
  && door.autoOpenOnAuth !== false;

/** Modo de disparo efectivo de la puerta ('cloud' por defecto, retrocompatible). */
const resolveRelayMode = (door = {}) => (door.relayMode === 'local' ? 'local' : 'cloud');

/**
 * Arma los datos de conexión que viajan al bridge en modo local.
 * @param {object} relayConfig  salida de doorController.buildRelayConfigForDoor
 */
const buildLocalRelayPayload = (relayConfig = {}) => ({
  driver: relayConfig.driver || 'sr201',
  host: String(relayConfig.host || ''),
  port: Number(relayConfig.port) || 6722,
  channel: Number(relayConfig.relayChannel) || 1,
  pulseMode: relayConfig.pulseMode === 'jog' ? 'jog' : 'timed',
  pulseSeconds: Math.max(1, Math.min(99, Number(relayConfig.pulseSeconds) || 3))
});

module.exports = {
  RELAY_MODES,
  shouldAttemptRelay,
  resolveRelayMode,
  buildLocalRelayPayload
};
