/**
 * Cliente HTTP centralizado para Firebase Cloud Functions.
 * Agrega Authorization, normaliza errores y maneja sesión expirada.
 */

export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

export const SESSION_EXPIRED_MESSAGE = 'Tu sesión expiró. Iniciá sesión de nuevo.';
export const NETWORK_ERROR_MESSAGE = 'No se pudo conectar con el servidor. Revisá tu conexión a internet.';
export const GENERIC_ERROR_MESSAGE = 'Ocurrió un error inesperado. Intentá de nuevo o avisá a soporte.';

let sessionExpiredHandler = null;
let sessionExpiryNotified = false;

/**
 * Registra el handler de sesión expirada (logout + toast).
 * Llamar desde AuthProvider / Toast al montar.
 */
export function setSessionExpiredHandler(handler) {
  sessionExpiredHandler = typeof handler === 'function' ? handler : null;
}

export function resetSessionExpiryFlag() {
  sessionExpiryNotified = false;
}

const isLoginPath = (path = '') => {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized === '/auth/login' || normalized.startsWith('/auth/login?');
};

const resolveToken = (explicitToken) => {
  if (explicitToken === null) return null; // caller opts out
  if (typeof explicitToken === 'string' && explicitToken.length) return explicitToken;
  if (explicitToken === undefined) {
    try {
      return localStorage.getItem('authToken');
    } catch {
      return null;
    }
  }
  return null;
};

const buildErrorMessage = (data, status) => {
  if (data && typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }
  if (data && typeof data.error === 'string' && data.error.trim()) {
    // Preferir message; si solo hay error técnico corto, usarlo
    const errText = data.error.trim();
    if (errText.length < 200 && !/^Error:/i.test(errText)) return errText;
  }
  return GENERIC_ERROR_MESSAGE;
};

const parseBody = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const text = await response.text().catch(() => '');
  return text ? { message: null, _raw: text } : null;
};

const triggerSessionExpired = () => {
  try {
    localStorage.removeItem('authToken');
  } catch {
    // ignore
  }
  if (!sessionExpiryNotified) {
    sessionExpiryNotified = true;
    sessionExpiredHandler?.(SESSION_EXPIRED_MESSAGE);
  } else {
    sessionExpiredHandler?.(null); // logout sin re-toast
  }
};

/**
 * @param {string} path - Ruta relativa (ej. '/auth/login')
 * @param {{
 *   method?: string,
 *   token?: string|null,
 *   body?: any,
 *   headers?: Record<string,string>,
 *   allowForbidden?: boolean,
 *   skipSessionExpiry?: boolean
 * }} options
 * - token: string usa ese Bearer; undefined → localStorage; null → sin Authorization
 * - allowForbidden: 403 no cierra sesión (permiso denegado esperado)
 * - skipSessionExpiry: no forzar logout (p.ej. login con clave incorrecta)
 */
export async function apiFetch(path, options = {}) {
  const {
    method = 'GET',
    token: tokenOption,
    body,
    headers: extraHeaders = {},
    allowForbidden = false,
    skipSessionExpiry = false
  } = options;

  const normalized = path.startsWith('/') ? path : `/${path}`;
  const headers = { ...extraHeaders };
  const token = resolveToken(tokenOption);

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${normalized}`, {
      method,
      headers,
      body: body === undefined
        ? undefined
        : (isFormData || typeof body === 'string' ? body : JSON.stringify(body))
    });
  } catch (error) {
    if (error instanceof TypeError) {
      const err = new Error(NETWORK_ERROR_MESSAGE);
      err.cause = error;
      err.isNetworkError = true;
      err.status = 0;
      throw err;
    }
    throw error;
  }

  const data = await parseBody(response);
  const skipExpiry = skipSessionExpiry || isLoginPath(normalized);

  if (!response.ok) {
    const status = response.status;
    const isAuthFailure = status === 401 || (status === 403 && !allowForbidden);

    if (isAuthFailure && !skipExpiry) {
      triggerSessionExpired();
      const err = new Error(SESSION_EXPIRED_MESSAGE);
      err.status = status;
      err.isSessionExpired = true;
      err.data = data;
      throw err;
    }

    const message = buildErrorMessage(data, status);
    const err = new Error(message);
    err.status = status;
    err.data = data;
    throw err;
  }

  return data ?? {};
}

export default apiFetch;
