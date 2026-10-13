'use strict';

/**
 * Firma Ed25519 de requests LAN entre equipos edge (hub ⇄ controlador) y verificación de la
 * firma de la nube sobre `compiled/head` (docs/ETAPA2-DISENO.md §4).
 *
 * Contrato (idéntico al que ya usa el hub en scripts/edge/hub/lanSignCompat.js y headSignature.js):
 *
 *   Request firmada — headers:
 *     x-mss-device  id del equipo que firma (deviceId)
 *     x-mss-ts      instante en ms epoch del emisor
 *     x-mss-sig     base64( Ed25519( `${METHOD}\n${path}\n${ts}\n${sha256hex(body)}` ) )
 *   path = path + query tal como viaja (al verificar también se acepta solo el pathname);
 *   body = bytes crudos (vacío → sha256 de ""). Ventana ±60 s. En requests no-GET se rechaza
 *   una firma ya vista dentro de la ventana (anti-replay). Fail-secure ante cualquier dato raro.
 *
 *   Head de la nube: head.sig = base64( Ed25519( canonicalJson({ version, chunks }) ) ) con la clave
 *   `head.keyId`. Los hashes de cada chunk los verifica ChunkStore, así que firmar {version, chunks}
 *   cubre todo el bundle.
 *
 * Claves: KeyObject, PEM (SPKI / PKCS8), base64 / base64url de 32 bytes crudos, DER base64 o hex.
 * Sin dependencias (solo `crypto`).
 */

const crypto = require('crypto');

const WINDOW_MS = 60 * 1000;
const HEADERS = Object.freeze({
  device: 'x-mss-device',
  ts: 'x-mss-ts',
  sig: 'x-mss-sig'
});
/** Header opcional con la hora del que responde (ms). Si falta se usa `Date` (resolución 1 s). */
const TIME_HEADER = 'x-mss-time';

// Prefijos DER para envolver claves Ed25519 crudas de 32 bytes (RFC 8410).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const sha256Hex = (raw) => crypto.createHash('sha256').update(raw == null ? '' : raw).digest('hex');

/** JSON canónico: claves ordenadas, sin espacios (mismo criterio que chunkStore.canonicalJson). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** base64 / base64url / hex → Buffer. */
function decodeLoose(str) {
  const s = String(str).trim();
  if (/^([0-9a-f]{64}|[0-9a-f]{128})$/i.test(s)) return Buffer.from(s, 'hex');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function toPublicKey(key) {
  if (!key) throw new TypeError('lanSign: falta la clave pública');
  if (key instanceof crypto.KeyObject) return key.type === 'private' ? crypto.createPublicKey(key) : key;
  const s = String(key).trim();
  if (s.startsWith('-----BEGIN')) {
    return /PRIVATE/.test(s) ? crypto.createPublicKey(crypto.createPrivateKey(s)) : crypto.createPublicKey(s);
  }
  const der = decodeLoose(s);
  if (der.length === 32) return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, der]), format: 'der', type: 'spki' });
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function toPrivateKey(key) {
  if (!key) throw new TypeError('lanSign: falta la clave privada');
  if (key instanceof crypto.KeyObject) {
    if (key.type !== 'private') throw new TypeError('lanSign: se esperaba una clave privada');
    return key;
  }
  const s = String(key).trim();
  if (s.startsWith('-----BEGIN')) return crypto.createPrivateKey(s);
  const der = decodeLoose(s);
  if (der.length === 32) return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, der]), format: 'der', type: 'pkcs8' });
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** Clave pública en base64 de 32 bytes crudos (forma corta para config / Firestore). */
function publicKeyRawB64(key) {
  const der = toPublicKey(key).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

/** Par nuevo: KeyObjects + PEM + forma corta base64 de la pública (`publicKeyB64` = `publicKeyRaw`). */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKeyRawB64(publicKey);
  return {
    publicKey,
    privateKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyB64: raw,
    publicKeyRaw: raw
  };
}

function signString(privateKey, text) {
  return crypto.sign(null, Buffer.from(String(text), 'utf8'), toPrivateKey(privateKey)).toString('base64');
}

/** Nunca lanza. Firma en base64, base64url o hex. */
function verifyString(publicKey, text, sig) {
  if (!sig || typeof sig !== 'string') return false;
  try {
    const buf = decodeLoose(sig);
    if (buf.length !== 64) return false;
    return crypto.verify(null, Buffer.from(String(text), 'utf8'), toPublicKey(publicKey), buf);
  } catch (_) {
    return false;
  }
}

function canonicalRequest({ method, path, ts, bodyHash }) {
  return `${String(method || 'GET').toUpperCase()}\n${String(path || '/')}\n${String(ts)}\n${bodyHash}`;
}

const bodyBytes = (body) => {
  if (body === undefined || body === null) return '';
  if (Buffer.isBuffer(body) || typeof body === 'string') return body;
  return JSON.stringify(body);
};

/**
 * @param {{privateKey, keyId?:string, deviceId?:string, method:string, path:string, body?:string|Buffer|object, now?:number}} p
 * @returns {Object<string,string>} headers a agregar (el body debe viajar EXACTO como se firmó)
 */
function signRequest({ privateKey, keyId, deviceId, method = 'GET', path = '/', body = '', now = Date.now() }) {
  const id = deviceId || keyId;
  if (!id) throw new TypeError('signRequest: falta deviceId');
  const ts = String(Math.round(Number(now)));
  return {
    [HEADERS.device]: String(id),
    [HEADERS.ts]: ts,
    [HEADERS.sig]: signString(privateKey, canonicalRequest({ method, path, ts, bodyHash: sha256Hex(bodyBytes(body)) }))
  };
}

/** Anti-replay: firmas vistas dentro de la ventana. */
function createNonceStore({ ttlMs = WINDOW_MS * 2, maxSize = 50000 } = {}) {
  const seen = new Map();
  return {
    /** true si es nueva (y la registra); false si ya se vio. */
    check(key, nowMs = Date.now()) {
      for (const [k, exp] of seen) {
        if (exp > nowMs && seen.size < maxSize) break;
        seen.delete(k);
      }
      if (seen.has(key) && seen.get(key) > nowMs) return false;
      seen.set(key, nowMs + ttlMs);
      return true;
    },
    size: () => seen.size
  };
}

const headerOf = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Verifica una request firmada.
 * @param {Object} p
 * @param {string} p.method
 * @param {string} p.path           req.url (path + query)
 * @param {Object} p.headers
 * @param {string|Buffer} [p.body]  body crudo
 * @param {(deviceId:string)=>any} p.resolveKey  clave pública del emisor o null (no enrolado / revocado)
 * @param {ReturnType<typeof createNonceStore>} [p.nonceStore]  anti-replay (solo no-GET)
 * @param {number} [p.now]
 * @param {number} [p.windowMs=60000]
 * @returns {{ok:true, deviceId:string} | {ok:false, code:string, message:string}}
 *   códigos: LAN_SIG_MISSING, DEVICE_NOT_ENROLLED, LAN_SIG_BAD_TS, LAN_SIG_EXPIRED, LAN_SIG_INVALID, LAN_SIG_REPLAY
 */
function verifyRequest({ method, path, headers, body = '', resolveKey, nonceStore = null, now = Date.now(), windowMs = WINDOW_MS }) {
  const fail = (code, message) => ({ ok: false, code, message });
  const deviceId = headerOf(headers, HEADERS.device);
  const tsRaw = headerOf(headers, HEADERS.ts);
  const sig = headerOf(headers, HEADERS.sig);
  if (!deviceId || !tsRaw || !sig) return fail('LAN_SIG_MISSING', 'Request sin firma');
  let pub = null;
  try {
    pub = typeof resolveKey === 'function' ? resolveKey(String(deviceId)) : null;
  } catch (_) {
    pub = null;
  }
  if (!pub) return fail('DEVICE_NOT_ENROLLED', `Equipo "${deviceId}" no autorizado`);
  let tsMs = Number(tsRaw);
  if (!Number.isFinite(tsMs)) return fail('LAN_SIG_BAD_TS', 'Timestamp inválido');
  if (tsMs < 1e12) tsMs *= 1000; // aceptar segundos
  if (Math.abs(Number(now) - tsMs) > windowMs) return fail('LAN_SIG_EXPIRED', 'Firma fuera de la ventana de 60 s (revisar reloj)');
  const full = String(path || '/');
  const pathOnly = full.split('?')[0];
  const bodyHash = sha256Hex(bodyBytes(body));
  const candidates = pathOnly === full ? [full] : [full, pathOnly];
  const ok = candidates.some((p) => verifyString(pub, canonicalRequest({ method, path: p, ts: tsRaw, bodyHash }), String(sig)));
  if (!ok) return fail('LAN_SIG_INVALID', 'Firma inválida');
  if (nonceStore && String(method).toUpperCase() !== 'GET' && !nonceStore.check(`${deviceId}|${sig}`, Number(now))) {
    return fail('LAN_SIG_REPLAY', 'Request repetida');
  }
  return { ok: true, deviceId: String(deviceId) };
}

/** Misma API que LanVerifier del hub (lanSignCompat), para poder unificar. */
class LanVerifier {
  constructor({ publicKeyFor, windowMs = WINDOW_MS, now = () => Date.now() }) {
    this.publicKeyFor = publicKeyFor;
    this.windowMs = windowMs;
    this.now = now;
    this.nonces = createNonceStore({ ttlMs: windowMs * 2 });
  }

  verify({ method, url, headers, body = '' }) {
    return verifyRequest({
      method, path: url, headers, body, resolveKey: this.publicKeyFor, nonceStore: this.nonces, now: this.now(), windowMs: this.windowMs
    });
  }
}

// ─────────────────────────── Head de la nube ───────────────────────────

const headSigningText = (head) => canonicalJson({ version: Number(head && head.version), chunks: (head && head.chunks) || {} });

function signHead(head, privateKey, keyId = 'cloud') {
  return { ...head, keyId, sig: signString(privateKey, headSigningText(head)) };
}

/**
 * @param {object} head
 * @param {any|Object<string,any>} keys  una clave pública, o mapa keyId → clave (rotación).
 *   Con mapa de una sola clave se acepta un head sin keyId (igual que el hub).
 */
function verifyHead(head, keys) {
  if (!head || typeof head !== 'object' || !head.sig || !keys) return false;
  let pub = keys;
  const isMap = !(keys instanceof crypto.KeyObject) && typeof keys === 'object' && !Buffer.isBuffer(keys);
  if (isMap) {
    const vals = Object.values(keys).filter(Boolean);
    pub = keys[head.keyId] || (!head.keyId && vals.length === 1 ? vals[0] : null);
    if (!pub) return false;
  }
  return verifyString(pub, headSigningText(head), head.sig);
}

// ─────────────────────────── Cliente HTTP firmado ───────────────────────────

/** Hora del servidor en ms: `x-mss-time` o, si falta, el header estándar `Date` (+500 ms, resolución 1 s). */
function serverTimeFrom(headers) {
  const st = Number(headerOf(headers, TIME_HEADER));
  if (Number.isFinite(st) && st > 0) return st;
  const d = Date.parse(headerOf(headers, 'date') || '');
  return Number.isFinite(d) ? d + 500 : null;
}

/**
 * fetch firmado (Node 20+). El body se serializa una sola vez y se firma exacto.
 * @returns {Promise<{status:number, ok:boolean, data:any, headers:Headers, rttMs:number, sentAtMs:number, serverTimeMs:number|null}>}
 */
async function signedFetch(url, {
  method = 'GET', body, privateKey, keyId, deviceId, timeoutMs = 10000, fetchFn = globalThis.fetch, now = () => Date.now()
} = {}) {
  const u = new URL(url);
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const t0 = now();
  const headers = {
    accept: 'application/json',
    ...(raw ? { 'content-type': 'application/json' } : {}),
    ...signRequest({ privateKey, deviceId: deviceId || keyId, method, path: `${u.pathname}${u.search}`, body: raw, now: t0 })
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(u.toString(), { method, headers, body: raw || undefined, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    data,
    headers: res.headers,
    rttMs: now() - t0,
    sentAtMs: t0,
    serverTimeMs: serverTimeFrom(res.headers)
  };
}

module.exports = {
  WINDOW_MS,
  HEADERS,
  TIME_HEADER,
  sha256Hex,
  canonicalJson,
  canonicalRequest,
  decodeLoose,
  toPublicKey,
  toPrivateKey,
  publicKeyRawB64,
  generateKeyPair,
  signString,
  verifyString,
  signRequest,
  verifyRequest,
  createNonceStore,
  LanVerifier,
  headSigningText,
  signHead,
  verifyHead,
  serverTimeFrom,
  signedFetch
};
