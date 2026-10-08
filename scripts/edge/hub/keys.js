'use strict';

/**
 * Utilidades Ed25519 del hub (sin dependencias): carga de claves en varios formatos,
 * firma y verificación.
 *
 * Formatos de clave pública aceptados: PEM (SPKI), base64/base64url de 32 bytes crudos,
 * base64 de DER SPKI, hex de 32 bytes, o un KeyObject.
 * Clave privada: PEM PKCS#8 (texto o ruta a archivo) o KeyObject.
 */

const crypto = require('crypto');
const fs = require('fs');

// Prefijo DER SPKI para Ed25519 (RFC 8410): 302a300506032b6570032100 + 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeLoose(str) {
  const s = String(str).trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** @returns {crypto.KeyObject} */
function publicKeyFrom(input) {
  if (!input) throw new Error('clave pública vacía');
  if (input instanceof crypto.KeyObject) return input.type === 'private' ? crypto.createPublicKey(input) : input;
  const s = String(input).trim();
  if (s.includes('-----BEGIN')) return crypto.createPublicKey(s);
  const der = decodeLoose(s);
  if (der.length === 32) {
    return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, der]), format: 'der', type: 'spki' });
  }
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** @returns {crypto.KeyObject} */
function privateKeyFrom(input) {
  if (!input) throw new Error('clave privada vacía');
  if (input instanceof crypto.KeyObject) return input;
  let s = String(input).trim();
  if (!s.includes('-----BEGIN') && fs.existsSync(s)) s = fs.readFileSync(s, 'utf8');
  return crypto.createPrivateKey(s);
}

/** Firma Ed25519 → base64. */
function sign(privateKey, message) {
  return crypto.sign(null, Buffer.from(message, 'utf8'), privateKeyFrom(privateKey)).toString('base64');
}

/** Verifica una firma Ed25519 (base64, base64url o hex). Nunca lanza. */
function verify(publicKey, message, signature) {
  try {
    if (!signature) return false;
    const sig = decodeLoose(signature);
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKeyFrom(publicKey), sig);
  } catch (_) {
    return false;
  }
}

/** Par nuevo (tests y enrolamiento): { privateKeyPem, publicKeyPem, publicKeyRaw (base64) }. */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKey,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicKeyRaw: spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64')
  };
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data === undefined || data === null ? '' : data).digest('hex');
}

module.exports = { publicKeyFrom, privateKeyFrom, sign, verify, generateKeyPair, sha256Hex };
