import { API_BASE_URL } from '../services/api';

const DEFAULT_TIMEOUT_MS = 2500;

/**
 * Chequeo real de salida al backend (no solo navigator.onLine).
 * @param {{ timeoutMs?: number, token?: string|null }} [options]
 * @returns {Promise<{ online: boolean, reason?: string }>}
 */
export async function checkBackendConnectivity(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { online: false, reason: 'navigator_offline' };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => {
    try {
      controller?.abort();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const headers = {};
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: controller?.signal
    });
    if (!response.ok) {
      return { online: false, reason: `http_${response.status}` };
    }
    return { online: true };
  } catch (err) {
    return {
      online: false,
      reason: err?.name === 'AbortError' ? 'timeout' : 'fetch_failed'
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Criterio pesimista: si el navegador dice offline, o el health falla → offline. */
export async function isReallyOnline(options = {}) {
  const result = await checkBackendConnectivity(options);
  return result.online;
}
