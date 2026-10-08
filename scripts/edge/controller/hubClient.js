'use strict';

/**
 * Cliente LAN controlador → hub (requests firmadas con lanSign) + reloj corregido.
 *
 * Contrato con el hub (lo implementa scripts/edge/hub):
 *   GET  /edge/config/chunks              → { head }                    (solo el head firmado por la nube)
 *   GET  /edge/config/chunks?names=a,b    → { head, chunks:{a:body, b:body} }
 *   POST /edge/events  { deviceId, configVersion, status, events:[...] } → { ackSeq }
 *        (events vacío = heartbeat cada heartbeatMs; el hub marca device_offline a los 15 s sin heartbeat)
 * Toda respuesta del hub debería traer `x-mss-time: <ms>` para estimar el desfase de reloj.
 */

const lanSign = require('../lib/lanSign');

class HubError extends Error {
  constructor(message, { status = 0, code = 'HUB_ERROR', data = null } = {}) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/**
 * Reloj del controlador: Date.now() corregido por el desfase medido contra el hub.
 * trusted: config `true/false`, o 'auto' = hay muestra reciente y |desfase| ≤ maxDriftMs.
 */
class EdgeClock {
  constructor({ trusted = 'auto', maxDriftMs = 120000, sampleMaxAgeMs = 6 * 3600 * 1000, systemNow = () => Date.now() } = {}) {
    this.mode = trusted;
    this.maxDriftMs = maxDriftMs;
    this.sampleMaxAgeMs = sampleMaxAgeMs;
    this.systemNow = systemNow;
    this.offsetMs = 0;
    this.sampledAt = null;
    this.lastRttMs = null;
  }

  now() {
    return this.systemNow() + this.offsetMs;
  }

  /** Muestra de la hora del hub. Se descartan muestras con RTT alto (> 2 s). */
  sample(serverTimeMs, sentAtMs, rttMs) {
    if (!Number.isFinite(serverTimeMs) || !Number.isFinite(sentAtMs) || !Number.isFinite(rttMs) || rttMs > 2000) return false;
    this.offsetMs = Math.round(serverTimeMs - (sentAtMs + rttMs / 2));
    this.sampledAt = this.systemNow();
    this.lastRttMs = rttMs;
    return true;
  }

  trusted() {
    if (this.mode === true) return true;
    if (this.mode === false) return false;
    if (this.sampledAt === null || this.systemNow() - this.sampledAt > this.sampleMaxAgeMs) return false;
    return Math.abs(this.offsetMs) <= this.maxDriftMs;
  }

  /** Calidad del reloj para el journal (`clockQ`). */
  quality() {
    if (this.mode === true) return 'config';
    if (this.trusted()) return 'synced';
    return this.sampledAt === null ? 'unsynced' : 'drift';
  }

  status() {
    return { mode: this.mode, offsetMs: this.offsetMs, sampledAt: this.sampledAt, rttMs: this.lastRttMs, trusted: this.trusted(), quality: this.quality() };
  }
}

class HubClient {
  /**
   * @param {{url:string, deviceId:string, privateKey:any, clock?:EdgeClock, timeoutMs?:number, fetchFn?:Function, systemNow?:()=>number}} opts
   */
  constructor({ url, deviceId, privateKey, clock = null, timeoutMs = 8000, fetchFn = globalThis.fetch, systemNow = () => Date.now() }) {
    this.url = url ? String(url).replace(/\/+$/, '') : null;
    this.deviceId = deviceId;
    this.privateKey = privateKey;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
    this.systemNow = systemNow;
    this.lastOkAt = null;
    this.lastError = null;
  }

  async request(method, pathAndQuery, body) {
    if (!this.url) throw new HubError('Hub no configurado', { code: 'HUB_NOT_CONFIGURED' });
    let res;
    try {
      res = await lanSign.signedFetch(`${this.url}${pathAndQuery}`, {
        method, body, privateKey: this.privateKey, keyId: this.deviceId, timeoutMs: this.timeoutMs, fetchFn: this.fetchFn, now: this.systemNow
      });
    } catch (err) {
      this.lastError = err.message;
      throw new HubError(`Hub inalcanzable: ${err.message}`, { code: 'HUB_UNREACHABLE' });
    }
    if (this.clock && res.serverTimeMs !== null) this.clock.sample(res.serverTimeMs, res.sentAtMs, res.rttMs);
    if (!res.ok) {
      const msg = (res.data && (res.data.message || res.data.error)) || `Hub respondió ${res.status}`;
      this.lastError = msg;
      throw new HubError(msg, { status: res.status, code: (res.data && res.data.code) || 'HUB_HTTP', data: res.data });
    }
    this.lastOkAt = this.systemNow();
    this.lastError = null;
    return res.data;
  }

  /** names vacío → solo el head. */
  getChunks(names = []) {
    const q = names.length ? `?names=${encodeURIComponent(names.join(','))}` : '';
    return this.request('GET', `/edge/config/chunks${q}`);
  }

  pushEvents(payload) {
    return this.request('POST', '/edge/events', payload);
  }
}

module.exports = { HubClient, HubError, EdgeClock };
