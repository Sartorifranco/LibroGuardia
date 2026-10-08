'use strict';

/**
 * Firma Ed25519 de requests LAN entre equipos edge (hub ⇄ controlador) y verificación
 * de la firma de la nube sobre `compiled/head` (docs/ETAPA2-DISENO.md §4).
 *
 * Request firmada — headers:
 *   x-mss-edge-key    id de la clave que firma (deviceId del emisor)
 *   x-mss-edge-ts     instante en ms epoch del emisor
 *   x-mss-edge-nonce  aleatorio (16 bytes hex); el receptor rechaza repetidos en la ventana
 *   x-mss-edge-sig    base64 de Ed25519(privateKey, canonicalRequest)
 *
 * canonicalRequest = "MSS-EDGE-1\n" + METHOD + "\n" + path(+query) + "\n" + ts + "\n" + nonce + "\n" + sha256hex(body)
 * (body = bytes crudos tal como viajan; vacío → sha256 de "").
 * Ventana ±60 s. Fail-secure: cualquier dato faltante o raro → rechazo.
 *
 * Firma del head de la nube: Ed25519 sobre canonicalJson(head sin `sig` ni `keyId`), base64 en `head.sig`.
 *
 * Claves: se aceptan KeyObject, PEM (SPKI / PKCS8) o base64 (32 bytes crudos o DER SPKI/PKCS8).
 * Sin dependencias (solo `crypto`). Lo usan el controlador y el hub.
 */

const crypto = require('crypto');

const SCHEME = 'MSS-EDGE-1';
const WINDOW_MS = 60 * 1000;
const HEADERS = Object.freeze({
  key: 'x-mss-edge-key',
  ts: 'x-mss-edge-ts',
  nonce: 'x-mss-edge-nonce',
  sig: 'x-mss-edge-sig'
});
/** Header opcional con la hora del que responde (ms); sirve para estimar el desfase de reloj. */
const TIME_HEADER = 'x-mss-time';

// Prefijos DER para envolver claves Ed25519 crudas de 32 bytes.
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

function toPublicKey(key) {
  if (!key) throw new TypeError('lanSign: falta la clave pública');
  if (key instanceof crypto.KeyObject) {
    return key.type === 'private' ? crypto.createPublicKey(key) : key;
  }
  const s = String(key).trim();
  if (s.startsWith('-----BEGIN')) {
    return /PRIVATE/.test(s) ? crypto.createPublicKey(crypto.createPrivateKey(s)) : crypto.createPublicKey(s);
  }
  const der = Buffer.from(s, 'base64');
  if (der.length === 32) {
    return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, der]), format: 'der', type: 'spki' });
  }
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
  const der = Buffer.from(s, 'base64');
  if (der.length === 32) {
    return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, der]), format: 'der', type: 'pkcs8' });
  }
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** Clave pública en base64 de 32 bytes crudos (forma corta para config / Firestore). */
function publicKeyRawB64(key) {
  const der = toPublicKey(key).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

/** Par nuevo. Devuelve PEM + forma corta base64 de la pública. */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyB64: publicKeyRawB64(publicKey)
  };
}

function signString(privateKey, text) {
  return crypto.sign(null, Buffer.from(String(text), 'utf8'), toPrivateKey(privateKey)).toString('base64');
}

function verifyString(publicKey, text, sigB64) {
  if (!sigB64 || typeof sigB64 !== 'string') return false;
  try {
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(String(text), 'utf8'), toPublicKey(publicKey), sig);
  } catch (_) {
    return false;
  }
}

function canonicalRequest({ method, path, ts, nonce, bodyHash }) {
  return [SCHEME, String(method || 'GET').toUpperCase(), String(path || '/'), String(ts), String(nonce), bodyHash].join('\n');
}

const bodyToString = (body) => {
  if (body === undefined || body === null) return '';
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
};

/**
 * @param {{privateKey, keyId:string, method:string, path:string, body?:string|Buffer|object, now?:number, nonce?:string}} p
 * @returns {Object<string,string>} headers a agregar a la request (el body debe viajar EXACTO como se firmó)
 */
function signRequest({ privateKey, keyId, method = 'GET', path = '/', body = '', now = Date.now(), nonce = null }) {
  if (!keyId) throw new TypeError('signRequest: falta keyId');
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const ts = Math.round(Number(now));
  const sig = signString(privateKey, canonicalRequest({ method, path, ts, nonce: n, bodyHash: sha256Hex(bodyToString(body)) }));
  return {
    [HEADERS.key]: String(keyId),
    [HEADERS.ts]: String(ts),
    [HEADERS.nonce]: n,
    [HEADERS.sig]: sig
  };
}

/** Anti-replay: nonces vistos dentro de la ventana. */
function createNonceStore({ ttlMs = WINDOW_MS * 2, maxSize = 50000 } = {}) {
  const seen = new Map();
  return {
    /** true si es nuevo (y lo registra); false si ya se vio. */
    check(keyId, nonce, nowMs = Date.now()) {
      for (const [k, exp] of seen) {
        if (exp > nowMs && seen.size < maxSize) break;
        seen.delete(k);
      }
      const k = `${keyId}|${nonce}`;
      if (seen.has(k) && seen.get(k) > nowMs) return false;
      seen.set(k, nowMs + ttlMs);
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
 * @param {string} p.path           path + query tal como llegó (req.url)
 * @param {Object} p.headers
 * @param {string|Buffer} [p.body]  body crudo
 * @param {(keyId:string)=>any} p.resolveKey  clave pública del emisor o null (no registrado / revocado)
 * @param {ReturnType<typeof createNonceStore>} [p.nonceStore]
 * @param {number} [p.now]
 * @param {number} [p.windowMs=60000]
 * @returns {{ok:true, keyId:string} | {ok:false, code:string, message:string}}
 */
function verifyRequest({ method, path, headers, body = '', resolveKey, nonceStore = null, now = Date.now(), windowMs = WINDOW_MS }) {
  const fail = (code, message) => ({ ok: false, code, message });
  const keyId = headerOf(headers, HEADERS.key);
  const tsRaw = headerOf(headers, HEADERS.ts);
  const nonce = headerOf(headers, HEADERS.nonce);
  const sig = headerOf(headers, HEADERS.sig);
  if (!keyId || !tsRaw || !nonce || !sig) return fail('SIG_MISSING', 'Request sin firma');
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return fail('SIG_BAD_TS', 'Timestamp inválido');
  if (Math.abs(Number(now) - ts) > windowMs) return fail('SIG_EXPIRED', 'Firma fuera de la ventana de 60 s (revisar reloj)');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(nonce))) return fail('SIG_BAD_NONCE', 'Nonce inválido');
  let pub = null;
  try {
    pub = typeof resolveKey === 'function' ? resolveKey(String(keyId)) : null;
  } catch (_) {
    pub = null;
  }
  if (!pub) return fail('SIG_UNKNOWN_KEY', `Clave "${keyId}" no autorizada`);
  const text = canonicalRequest({ method, path, ts: tsRaw, nonce, bodyHash: sha256Hex(bodyToString(body)) });
  if (!verifyString(pub, text, String(sig))) return fail('SIG_INVALID', 'Firma inválida');
  if (nonceStore && !nonceStore.check(String(keyId), String(nonce), Number(now))) {
    return fail('SIG_REPLAY', 'Request repetida');
  }
  return { ok: true, keyId: String(keyId) };
}

// ─────────────────────────── Head de la nube ───────────────────────────

const headSigningText = (head) => {
  const { sig, keyId, ...rest } = head || {};
  return canonicalJson(rest);
};

function signHead(head, privateKey, keyId = 'cloud') {
  const { sig: _s, keyId: _k, ...rest } = head || {};
  return { ...rest, keyId, sig: signString(privateKey, headSigningText(rest)) };
}

/**
 * @param {object} head
 * @param {any|Object<string,any>} keys  una clave pública o un mapa keyId → clave (rotación)
 */
function verifyHead(head, keys) {
  if (!head || typeof head !== 'object' || !head.sig || !keys) return false;
  let pub = keys;
  const isMap = !(keys instanceof crypto.KeyObject) && typeof keys === 'object' && !Buffer.isBuffer(keys);
  if (isMap) {
    pub = keys[head.keyId];
    if (!pub) return false;
  }
  return verifyString(pub, headSigningText(head), head.sig);
}

// ─────────────────────────── Cliente HTTP firmado ───────────────────────────

/**
 * fetch firmado (Node 20+). El body se serializa una sola vez y se firma exacto.
 * @returns {Promise<{status:number, ok:boolean, data:any, headers:Headers, rttMs:number, serverTimeMs:number|null}>}
 */
async function signedFetch(url, {
  method = 'GET', body, privateKey, keyId, timeoutMs = 10000, fetchFn = globalThis.fetch, now = () => Date.now()
} = {}) {
  const u = new URL(url);
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const t0 = now();
  const headers = {
    ...(raw ? { 'content-type': 'application/json' } : {}),
    ...signRequest({ privateKey, keyId, method, path: `${u.pathname}${u.search}`, body: raw, now: t0 })
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
  const st = Number(headerOf(res.headers, TIME_HEADER));
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    data,
    headers: res.headers,
    rttMs: now() - t0,
    sentAtMs: t0,
    serverTimeMs: Number.isFinite(st) ? st : null
  };
}

module.exports = {
  SCHEME,
  WINDOW_MS,
  HEADERS,
  TIME_HEADER,
  sha256Hex,
  canonicalJson,
  canonicalRequest,
  toPublicKey,
  toPrivateKey,
  publicKeyRawB64,
  generateKeyPair,
  signString,
  verifyString,
  signRequest,
  verifyRequest,
  createNonceStore,
  headSigningText,
  signHead,
  verifyHead,
  signedFetch
};
