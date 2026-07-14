/**
 * Cliente HTTP centralizado para Firebase Cloud Functions.
 * Base: REACT_APP_API_BASE_URL o /api (Hosting rewrite).
 */

export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

const parseJsonSafely = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const errorText = await response.text();
    const preview = errorText.substring(0, 200);
    const err = new Error(
      `El servidor respondió con un formato inesperado (no JSON). Código: ${response.status}. Mensaje: ${preview}...`
    );
    err.status = response.status;
    err.bodyText = errorText;
    throw err;
  }
  return response.json();
};

/**
 * @param {string} path - Ruta relativa (ej. '/auth/login' o 'auth/login')
 * @param {{ method?: string, token?: string|null, body?: any, headers?: Record<string,string> }} options
 */
export async function apiFetch(path, options = {}) {
  const {
    method = 'GET',
    token = null,
    body,
    headers: extraHeaders = {}
  } = options;

  const normalized = path.startsWith('/') ? path : `/${path}`;
  const headers = { ...extraHeaders };

  if (body !== undefined && !headers['Content-Type']) {
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
        : (typeof body === 'string' ? body : JSON.stringify(body))
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Failed to fetch') {
      const err = new Error(
        'No se pudo conectar con el servidor. Verifique la API (Firebase Functions) y la URL configurada.'
      );
      err.cause = error;
      err.isNetworkError = true;
      throw err;
    }
    throw error;
  }

  const data = await parseJsonSafely(response);

  if (!response.ok) {
    const err = new Error(data.message || data.error || `Error HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

export default apiFetch;
