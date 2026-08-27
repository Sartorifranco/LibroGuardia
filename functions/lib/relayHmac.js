/**
 * Firma HMAC-SHA256 Cloud → puente SR201 (`POST /pulse`).
 * Clave: el mismo bridgeSecret / BRIDGE_SECRET. Ventana ±60 s. Fail-secure.
 */

const crypto = require('crypto');

const WINDOW_SECONDS = 60;
const NONCE_TTL_MS = 2 * 60 * 1000;
const HMAC_HEADERS = {
  timestamp: 'x-mss-timestamp',
  nonce: 'x-mss-nonce',
  signature: 'x-mss-signature'
};

const sha256Hex = (raw) => crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

const createNonceStore = () => new Map();

const pruneNonces = (store, nowMs) => {
  if (!store) return;
  for (const [nonce, expiresAt] of store) {
    if (expiresAt <= nowMs) store.delete(nonce);
  }
};

const buildCanonicalString = ({
  method = 'POST',
  path = '/pulse',
  timestamp,
  nonce,
  body = ''
}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return [
    String(method || 'POST').toUpperCase(),
    String(path || '/pulse'),
    String(timestamp),
    String(nonce),
    sha256Hex(raw)
  ].join('\n');
};

const signCanonical = (secret, canonical) =>
  crypto.createHmac('sha256', String(secret)).update(canonical, 'utf8').digest('hex');

const timingSafeEqualHex = (expected, actual) => {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(actual || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const signRelayRequest = ({
  secret,
  method = 'POST',
  path = '/pulse',
  timestamp,
  nonce,
  body = ''
}) => {
  const ts = timestamp != null ? String(timestamp) : String(Math.floor(Date.now() / 1000));
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const canonical = buildCanonicalString({
    method,
    path,
    timestamp: ts,
    nonce: n,
    body: raw
  });
  const signature = signCanonical(secret, canonical);
  return {
    timestamp: ts,
    nonce: n,
    signature,
    headers: {
      'X-Mss-Timestamp': ts,
      'X-Mss-Nonce': n,
      'X-Mss-Signature': signature
    }
  };
};

const verifyRelayRequest = ({
  secret,
  method = 'POST',
  path = '/pulse',
  timestamp,
  nonce,
  signature,
  body = '',
  nowMs = Date.now(),
  seenNonces = null
}) => {
  if (!secret) return { ok: false, code: 'missing_secret' };
  if (!timestamp || !nonce || !signature) return { ok: false, code: 'missing_hmac' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, code: 'bad_timestamp' };
  if (Math.abs(nowMs / 1000 - ts) > WINDOW_SECONDS) return { ok: false, code: 'expired' };

  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const canonical = buildCanonicalString({
    method,
    path,
    timestamp: String(timestamp),
    nonce: String(nonce),
    body: raw
  });
  const expected = signCanonical(secret, canonical);
  if (!timingSafeEqualHex(expected, String(signature))) {
    return { ok: false, code: 'bad_signature' };
  }

  if (seenNonces) {
    pruneNonces(seenNonces, nowMs);
    const key = String(nonce);
    if (seenNonces.has(key)) return { ok: false, code: 'replay' };
    seenNonces.set(key, nowMs + NONCE_TTL_MS);
  }

  return { ok: true };
};

/**
 * Puente: Bearer + HMAC. Sin secreto no hay gate (mismo aviso actual).
 * Nunca pulsa el relé si esto no da ok.
 */
const authorizePulseRequest = ({
  secret,
  headers = {},
  rawBody = '',
  nowMs = Date.now(),
  seenNonces
}) => {
  if (!secret) return { ok: true, skipped: true };
  const authHeader = headers.authorization || headers.Authorization || '';
  if (authHeader !== `Bearer ${secret}`) {
    return { ok: false, status: 401, code: 'bearer' };
  }
  const verified = verifyRelayRequest({
    secret,
    method: 'POST',
    path: '/pulse',
    timestamp: headers[HMAC_HEADERS.timestamp] || headers['X-Mss-Timestamp'],
    nonce: headers[HMAC_HEADERS.nonce] || headers['X-Mss-Nonce'],
    signature: headers[HMAC_HEADERS.signature] || headers['X-Mss-Signature'],
    body: rawBody,
    nowMs,
    seenNonces
  });
  if (!verified.ok) return { ok: false, status: 401, code: verified.code };
  return { ok: true };
};

module.exports = {
  WINDOW_SECONDS,
  NONCE_TTL_MS,
  HMAC_HEADERS,
  createNonceStore,
  buildCanonicalString,
  signRelayRequest,
  verifyRelayRequest,
  authorizePulseRequest
};
