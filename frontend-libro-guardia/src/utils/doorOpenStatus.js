/**
 * Textos de apertura para guardia, supervisor y monitoreo.
 * El pedido a la estación (cola) no es lo mismo que la puerta ya abierta.
 */

const queuedVia = (value) => {
  const via = String(value || '').toLowerCase();
  return via === 'local-queue' || via === 'queue' || via === 'queued';
};

export function isDoorOpenQueued(data = {}) {
  const relay = data.relay && typeof data.relay === 'object' ? data.relay : {};
  const command = String(relay.command || data.command || '').toLowerCase();
  const status = String(relay.status || data.status || '').toLowerCase();
  return queuedVia(relay.via)
    || queuedVia(data.via)
    || queuedVia(data.relayVia)
    || String(data.relayStatus || '').toLowerCase() === 'en_cola'
    || command === 'queued'
    || status === 'pending'
    || status === 'queued';
}

/**
 * Confirmado solo si el backend dice que el disparo salió
 * (triggered) o si la estación local respondió en el acto.
 * `via: cloud` a veces lo pone el cliente cuando la API no aclara: no cuenta.
 */
/** La placa no contestó al comando: se mandó, pero no hay certeza de que abrió. */
export function isDoorOpenUnconfirmed(data = {}) {
  const relay = data.relay && typeof data.relay === 'object' ? data.relay : {};
  return relay.confirmed === false
    || data.relayConfirmed === false
    || String(data.relayStatus || '').toLowerCase() === 'sin_confirmacion';
}

export function isDoorOpenConfirmed(data = {}) {
  if (isDoorOpenQueued(data)) return false;
  if (isDoorOpenUnconfirmed(data)) return false;
  const relay = data.relay && typeof data.relay === 'object' ? data.relay : {};
  if (relay.confirmed === true || data.relayConfirmed === true) return true;
  if (String(data.relayStatus || '').toLowerCase() === 'confirmado') return true;
  if (relay.triggered === true || data.triggered === true) return true;
  if (data.opened === true || data.confirmed === true || relay.opened === true) return true;
  const relayVia = String(relay.via || '').toLowerCase();
  if (relayVia === 'local' || relayVia === 'tcp' || relayVia === 'bridge') return true;
  if (String(data.via || '').toLowerCase() === 'local') return true;
  return false;
}

export function doorOpenUserMessage(data = {}, doorLabel = '') {
  const prefix = doorLabel ? `${doorLabel}: ` : '';
  if (isDoorOpenQueued(data)) return `${prefix}Enviado a la estación, abre en unos segundos`;
  if (isDoorOpenUnconfirmed(data)) return `${prefix}Enviado, pero la puerta no confirmó. Verificá que haya abierto`;
  if (isDoorOpenConfirmed(data)) return `${prefix}Puerta abierta`;
  return `${prefix}Pedido enviado`;
}

/** Palabra de estado del último pedido. `ok: true` solo no alcanza: la cola también queda ok. */
export function lastPulseStatusWord(pulse) {
  if (!pulse) return '';
  if (pulse.ok === false || pulse.error) return 'Error';
  if (isDoorOpenQueued(pulse)) return 'Enviado a la estación';
  if (isDoorOpenUnconfirmed(pulse)) return 'Sin confirmación';
  if (isDoorOpenConfirmed(pulse)) return 'Abierta';
  return 'Pedido enviado';
}
