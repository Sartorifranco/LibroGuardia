'use strict';

/**
 * Cliente HTTP del hub contra la API edge de la nube (`/api/edge/v1/*`, T4).
 *
 * Autenticación del equipo:
 *   POST /api/edge/v1/token { deviceId, ts, signature, refreshToken }
 *     signature = base64(Ed25519(`mss-edge-token\n${deviceId}\n${ts}`)) con la clave del equipo
 *   → { token (JWT 1 h), refreshToken (rotado), firebaseToken (custom token, solo hub) }
 *   Si se pierde la respuesta (corte justo después de rotar), la nube acepta UNA vez el refresh
 *   anterior dentro de 5 min (gracia de rotación, functions/lib/devices.js).
 * El refresh token rotado se guarda cifrado en `meta` ANTES de usar el JWT nuevo.
 * El primer refresh token sale del enrolamiento (config `cloud.refreshToken`, solo si la base no tiene uno).
 *
 * `online` refleja si el último intento llegó a la nube (cualquier respuesta HTTP) o no.
 */

const { sign } = require('./keys');

const TOKEN_SKEW_MS = 2 * 60 * 1000;

class CloudError extends Error {
  constructor(message, { status = 0, code = null, retryable = true, body = null } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.body = body;
  }
}

function tokenSigningPayload(deviceId, ts) {
  return `mss-edge-token\n${deviceId}\n${ts}`;
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? Number(payload.exp) * 1000 : null;
  } catch (_) {
    return null;
  }
}

class CloudClient {
  /**
   * @param {{ baseUrl:string, deviceId:string, privateKey:any, secrets:import('./secretStore').SecretStore,
   *           bootstrapRefreshToken?:string, fetch?:Function, timeoutMs?:number, now?:()=>number, log?:object }} opts
   */
  constructor({ baseUrl, deviceId, privateKey, secrets, bootstrapRefreshToken = null, fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 15000, now = () => Date.now(), log = console }) {
    if (!baseUrl) throw new Error('CloudClient: falta baseUrl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.deviceId = deviceId;
    this.privateKey = privateKey;
    this.secrets = secrets;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.log = log;
    this.token = null;
    this.tokenExp = 0;
    this.firebaseCustomToken = null;
    this.online = null; // null = todavía no se intentó
    this.lastOkAt = null;
    this.lastError = null;
    if (bootstrapRefreshToken && !this.secrets.get('refreshToken')) this.secrets.set('refreshToken', bootstrapRefreshToken);
  }

  hasRefreshToken() {
    return Boolean(this.secrets.get('refreshToken'));
  }

  async rawFetch(method, path, body, headers = {}) {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      this.online = false;
      this.lastError = err.message;
      throw new CloudError(`Sin conexión con la nube (${method} ${path}): ${err.message}`, { code: 'NETWORK' });
    }
    this.online = true;
    this.lastOkAt = this.now();
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }
    if (!res.ok) {
      const code = (data && (data.code || data.error)) || `HTTP_${res.status}`;
      this.lastError = `${res.status} ${code}`;
      throw new CloudError(`Nube respondió ${res.status} en ${method} ${path}`, {
        status: res.status, code, body: data, retryable: res.status >= 500 || res.status === 429 || res.status === 408
      });
    }
    this.lastError = null;
    return data;
  }

  /** Pide un JWT nuevo con firma del equipo + refresh token; rota y persiste el refresh token. */
  async refreshAuth() {
    const refreshToken = this.secrets.get('refreshToken');
    if (!refreshToken) {
      throw new CloudError('Hub sin refresh token: enrolar el equipo (mss-edge enroll) o cargar cloud.refreshToken', {
        code: 'NOT_ENROLLED', retryable: false
      });
    }
    const ts = this.now();
    const signature = sign(this.privateKey, tokenSigningPayload(this.deviceId, ts));
    const data = await this.rawFetch('POST', '/api/edge/v1/token', { deviceId: this.deviceId, ts, signature, refreshToken });
    if (!data || !data.token) throw new CloudError('Respuesta de token inválida', { code: 'BAD_TOKEN_RESPONSE' });
    if (data.refreshToken && data.refreshToken !== refreshToken) this.secrets.set('refreshToken', data.refreshToken);
    this.token = data.token;
    this.tokenExp = jwtExpMs(data.token) || (ts + (Number(data.expiresIn) || 3600) * 1000);
    // La nube (functions/lib/devices.js) lo devuelve como `firebaseToken`; se acepta el nombre viejo.
    const fbToken = data.firebaseToken || data.firebaseCustomToken;
    if (fbToken) this.firebaseCustomToken = fbToken; // fase 2: listener Firestore
    return this.token;
  }

  async ensureToken() {
    if (this.token && this.tokenExp - TOKEN_SKEW_MS > this.now()) return this.token;
    return this.refreshAuth();
  }

  /** Request autenticada; ante 401 renueva el token y reintenta una vez. */
  async request(method, path, body) {
    await this.ensureToken();
    try {
      return await this.rawFetch(method, path, body, { authorization: `Bearer ${this.token}` });
    } catch (err) {
      if (err.status !== 401) throw err;
      this.token = null;
      await this.refreshAuth();
      return this.rawFetch(method, path, body, { authorization: `Bearer ${this.token}` });
    }
  }

  getHead() { return this.request('GET', '/api/edge/v1/head'); }

  getChunks(names) {
    return this.request('GET', `/api/edge/v1/chunks?names=${names.map(encodeURIComponent).join(',')}`);
  }

  postEvents(payload) { return this.request('POST', '/api/edge/v1/events', payload); }

  heartbeat(payload) { return this.request('POST', '/api/edge/v1/heartbeat', payload); }

  postLive(summary) { return this.request('POST', '/api/edge/v1/live', summary); }

  listCommands() { return this.request('GET', '/api/edge/v1/commands?status=pending'); }

  commandResult(id, result) {
    return this.request('POST', `/api/edge/v1/commands/${encodeURIComponent(id)}/result`, result);
  }
}

module.exports = { CloudClient, CloudError, tokenSigningPayload, jwtExpMs };
