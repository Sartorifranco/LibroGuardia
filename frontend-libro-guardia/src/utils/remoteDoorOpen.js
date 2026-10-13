import { apiFetch } from '../services/api';
import { isAirlockBusyError } from './openManualDoor';

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

export function commandStatus(payload = {}) {
  return String(
    payload.status
    || payload.command?.status
    || payload.state
    || ''
  ).toLowerCase();
}

export function commandIdOf(payload = {}) {
  return payload.command?.id || payload.commandId || payload.id || null;
}

export function commandFailureMessage(payload = {}) {
  return payload.message
    || payload.error
    || payload.reason
    || payload.failureReason
    || payload.detail
    || payload.command?.message
    || payload.command?.error
    || payload.command?.reason
    || 'la puerta no respondió';
}

export async function pollRemoteCommand({
  commandId,
  siteId = 'principal',
  token,
  timeoutMs = 45000,
  intervalMs = 2000
} = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await apiFetch(
      `/guard/commands/${encodeURIComponent(commandId)}?siteId=${encodeURIComponent(siteId)}`,
      { token, dedupe: false }
    );
    const status = commandStatus(last);
    if (status === 'done') return last;
    if (status === 'failed') {
      const err = new Error(commandFailureMessage(last));
      err.statusName = status;
      err.data = last;
      throw err;
    }
    if (status === 'expired') {
      const err = new Error(last?.message || 'Se agotó el tiempo de espera');
      err.statusName = status;
      err.data = last;
      throw err;
    }
    if (Date.now() - started + intervalMs >= timeoutMs) break;
    await sleep(intervalMs);
  }
  const err = new Error('No hubo respuesta de la puerta');
  err.statusName = 'timeout';
  err.data = last;
  throw err;
}

export async function openDoorRemote({
  doorId,
  siteId = 'principal',
  token,
  body = {}
} = {}) {
  const created = await apiFetch(
    `/guard/doors/${encodeURIComponent(doorId)}/remote-open`,
    { method: 'POST', token, body }
  );
  const initial = commandStatus(created);
  if (initial === 'done') return created;
  if (initial === 'failed' || initial === 'expired') {
    const err = new Error(commandFailureMessage(created));
    err.statusName = initial;
    err.data = created;
    throw err;
  }
  const commandId = commandIdOf(created);
  if (!commandId) {
    throw new Error('el pedido no tiene número');
  }
  return pollRemoteCommand({ commandId, siteId, token });
}

/**
 * Apertura en la nube para una puerta con controlador.
 * Consulta el comando hasta que termina. Si el estanco está ocupado y el
 * usuario puede forzar, pide motivo y reintenta (queda registrado).
 */
export async function openControllerDoor({
  door,
  authToken,
  canForceAirlock = false,
  confirmWithReason = null,
  forceAirlock = false,
  forceReason = ''
} = {}) {
  const siteId = door?.siteId || 'principal';
  try {
    return await openDoorRemote({
      doorId: door?.id,
      siteId,
      token: authToken,
      body: forceAirlock ? { forceAirlock: true, forceReason } : {}
    });
  } catch (err) {
    if (
      !isAirlockBusyError(err)
      || !canForceAirlock
      || typeof confirmWithReason !== 'function'
      || forceAirlock
    ) {
      throw err;
    }
    const reason = await confirmWithReason({
      title: 'Estanco ocupado',
      message: `${err.message}\n\n¿Forzar la apertura igual? Queda registrado con tu usuario y el motivo.`,
      confirmLabel: 'Forzar apertura (queda registrado)',
      cancelLabel: 'Cancelar',
      reasonLabel: 'Motivo (obligatorio)',
      tone: 'danger'
    });
    if (!reason) {
      const cancelled = new Error('Cancelado');
      cancelled.cancelled = true;
      throw cancelled;
    }
    return openControllerDoor({
      door,
      authToken,
      canForceAirlock,
      confirmWithReason,
      forceAirlock: true,
      forceReason: reason
    });
  }
}
