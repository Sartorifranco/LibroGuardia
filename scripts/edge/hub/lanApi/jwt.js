'use strict';

/**
 * JWT HS256 propio del hub. La clave vive en meta('hub_lan_jwt_secret') y se crea
 * al azar la primera vez. No usa JWT_SECRET de la nube ni la clave del equipo.
 */

const crypto = require('crypto');
const { readMeta, writeMeta } = require('../../lib/db/migrations');

const META_KEY = 'hub_lan_jwt_secret';
const TTL_SEC = 8 * 60 * 60;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function secretOf(db) {
  let secret = readMeta(db, META_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    writeMeta(db, META_KEY, secret);
  }
  return secret;
}

function signHs256(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyHs256(token, secret, nowMs) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, code: 'BAD_TOKEN' };
  const [h, p, s] = parts;
  let header;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch (_) { return { ok: false, code: 'BAD_TOKEN' }; }
  if (!header || header.alg !== 'HS256') return { ok: false, code: 'BAD_TOKEN' };
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'BAD_TOKEN' };
  let payload;
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (_) { return { ok: false, code: 'BAD_TOKEN' }; }
  if (!payload || typeof payload !== 'object') return { ok: false, code: 'BAD_TOKEN' };
  if (payload.exp && Number(nowMs) >= Number(payload.exp) * 1000) return { ok: false, code: 'EXPIRED' };
  return { ok: true, payload };
}

/**
 * Firma la sesión del operador. `passwordVersion` va en el token: si el chunk
 * lo sube, los tokens viejos dejan de valer.
 */
function signOperatorToken(db, op, nowMs) {
  const iat = Math.floor(Number(nowMs) / 1000);
  return signHs256({
    id: op.id,
    username: op.username,
    role: op.role,
    permissions: op.permissions,
    passwordVersion: op.passwordVersion,
    iat,
    exp: iat + TTL_SEC
  }, secretOf(db));
}

function verifyOperatorToken(db, token, nowMs) {
  return verifyHs256(token, secretOf(db), nowMs);
}

module.exports = { signOperatorToken, verifyOperatorToken, secretOf, META_KEY, TTL_SEC };
