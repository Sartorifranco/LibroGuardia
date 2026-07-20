/**
 * Driver genérico HTTP — POST/PUT a un webhook de relé/controladora.
 * Payload fijo: { action: 'open' | 'pulse', seconds }.
 *
 * Pensado para controladoras / ESP / Shelly / APIs caseras que exponen un endpoint HTTP.
 */

const DEFAULT_TIMEOUT_MS = 8000;

const triggerRelay = async (config = {}, { force = false } = {}) => {
  if (config.enabled === false && !force) {
    return { triggered: false, skipped: true, message: 'Control de acceso deshabilitado' };
  }

  const url = String(config.httpUrl || '').trim();
  if (!url) {
    throw new Error('Falta la URL HTTP del relé (device.httpUrl). Configurala en Admin → Puertas.');
  }

  const method = String(config.httpMethod || 'POST').toUpperCase();
  const seconds = Number(config.pulseSeconds) || 3;
  const action = config.pulseMode === 'timed' ? 'pulse' : 'open';
  const payload = { action, seconds };

  const headers = {
    'Content-Type': 'application/json',
    ...(config.httpAuthToken
      ? { Authorization: `Bearer ${String(config.httpAuthToken)}` }
      : {})
  };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload),
      signal: controller?.signal
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    throw new Error(
      aborted
        ? `Timeout al contactar el relé HTTP (${url})`
        : `No se pudo contactar el relé HTTP (${url}). Detalle: ${err.message || 'error de red'}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('El relé HTTP rechazó la autenticación (httpAuthToken).');
    }
    throw new Error(data.message || `Relé HTTP respondió ${response.status}`);
  }

  return {
    triggered: true,
    via: 'generic_http',
    command: `${action}:${seconds}`,
    httpStatus: response.status,
    ...data
  };
};

module.exports = {
  id: 'generic_http',
  triggerRelay
};
