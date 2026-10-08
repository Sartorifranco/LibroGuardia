'use strict';

/**
 * Firma Ed25519 de requests LAN (hub ⇄ controladores), versión mínima propia del hub.
 *
 * Contrato (el mismo que `scripts/edge/lib/lanSign.js` del controlador):
 *   headers  x-mss-device: <deviceId>
 *            x-mss-ts:     <ms epoch>
 *            x-mss-sig:    base64( Ed25519( `${METHOD}\n${path}\n${ts}\n${sha256hex(body)}` ) )
 *   ventana ±60 s.
 *
 * Tolerancias al verificar (para no romper si el otro lado difiere en un detalle):
 * - `path` con query (req.url) o solo el pathname;
 * - `ts` en ms o en segundos;
 * - firma en base64, base64url o hex.
 * Anti-replay: dentro de la ventana se rechaza una firma ya vista en requests no-GET.
 */

const { sign, verify, sha256Hex } = require('./keys');

const DEFAULT_WINDOW_MS = 60 * 1000;

function canonical(method, path, ts, body) {
  return `${String(method).toUpperCase()}\n${path}\n${ts}\n${sha256Hex(body || '')}`;
}

/**
 * @param {{method:string, path:string, body?:string|Buffer, deviceId:string, privateKey:any, now?:number}} p
 * @returns {Object<string,string>} headers a agregar
 */
function signRequest({ method, path, body = '', deviceId, privateKey, now = Date.now() }) {
  const ts = String(now);
  return {
    'x-mss-device': String(deviceId),
    'x-mss-ts': ts,
    'x-mss-sig': sign(privateKey, canonical(method, path, ts, body))
  };
}

class LanVerifier {
  /**
   * @param {{ publicKeyFor:(deviceId:string)=>any, windowMs?:number, now?:()=>number }} opts
   *   publicKeyFor devuelve la clave del equipo enrolado o null (no enrolado → rechazo).
   */
  constructor({ publicKeyFor, windowMs = DEFAULT_WINDOW_MS, now = () => Date.now() }) {
    this.publicKeyFor = publicKeyFor;
    this.windowMs = windowMs;
    this.now = now;
    this.seen = new Map(); // sig → expira
  }

  prune(nowMs) {
    if (this.seen.size < 1000) return;
    for (const [k, exp] of this.seen) if (exp < nowMs) this.seen.delete(k);
  }

  /**
   * @param {{method:string, url:string, headers:object, body?:string|Buffer}} req
   * @returns {{ok:true, deviceId:string} | {ok:false, code:string}}
   */
  verify({ method, url, headers, body = '' }) {
    const h = (k) => {
      const v = headers[k] ?? headers[k.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const deviceId = h('x-mss-device');
    const tsRaw = h('x-mss-ts');
    const sig = h('x-mss-sig');
    if (!deviceId || !tsRaw || !sig) return { ok: false, code: 'LAN_SIG_MISSING' };
    const pub = this.publicKeyFor(String(deviceId));
    if (!pub) return { ok: false, code: 'DEVICE_NOT_ENROLLED' };
    let tsMs = Number(tsRaw);
    if (!Number.isFinite(tsMs)) return { ok: false, code: 'LAN_SIG_BAD_TS' };
    if (tsMs < 1e12) tsMs *= 1000;
    const nowMs = this.now();
    if (Math.abs(nowMs - tsMs) > this.windowMs) return { ok: false, code: 'LAN_SIG_EXPIRED' };
    const pathOnly = String(url).split('?')[0];
    const candidates = pathOnly === url ? [url] : [url, pathOnly];
    const okSig = candidates.some((p) => verify(pub, canonical(method, p, tsRaw, body), sig));
    if (!okSig) return { ok: false, code: 'LAN_SIG_INVALID' };
    if (String(method).toUpperCase() !== 'GET') {
      this.prune(nowMs);
      if (this.seen.has(sig)) return { ok: false, code: 'LAN_SIG_REPLAY' };
      this.seen.set(sig, nowMs + this.windowMs);
    }
    return { ok: true, deviceId: String(deviceId) };
  }
}

module.exports = { signRequest, LanVerifier, canonical, DEFAULT_WINDOW_MS };
