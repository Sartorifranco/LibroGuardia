'use strict';

/**
 * Firma Ed25519 del head compilado (docs/ETAPA2-DISENO.md §4: "el bundle sigue
 * firmado por la nube; un hub comprometido no puede inventar derechos").
 *
 * Clave privada: env `EDGE_SIGNING_PRIVATE_KEY` (PEM PKCS#8). Si falta (tests,
 * emulador) se genera una efímera por proceso y se avisa una vez por consola:
 * los equipos NO aceptarían esos heads después de un reinicio. Cómo generar la
 * clave: ver README.md de esta carpeta.
 *
 * Lo firmado es exactamente `canonicalJson({version, chunks})` (canonical.js:
 * claves ordenadas, sin espacios); el resto del head (siteId, day, tz,
 * credentialKeyId, compiledAt, mode) es informativo y no está firmado. `keyId` = primeros 16 hex del sha256 de la clave
 * pública DER (SPKI), para rotar claves sin ambigüedad.
 */

const crypto = require('node:crypto');
const { canonicalJson } = require('./canonical');

/** Acordado con el hub (T6): Ed25519 sobre canonicalJson({version, chunks}). */
const SIGNED_FIELDS = ['version', 'chunks'];

let cached = null;
let warnedEphemeral = false;

const keyIdOf = (publicKey) => crypto.createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex')
  .slice(0, 16);

const fromPrivateKey = (privateKey, ephemeral) => {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('EDGE_SIGNING_PRIVATE_KEY debe ser una clave Ed25519');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: keyIdOf(publicKey),
    ephemeral
  };
};

/** PEM de env (admite `\n` escapados, típico de variables de entorno de una línea). */
const loadSigningKey = (env = process.env) => {
  const pem = String(env.EDGE_SIGNING_PRIVATE_KEY || '').trim();
  if (pem) {
    return fromPrivateKey(crypto.createPrivateKey(pem.replace(/\\n/g, '\n')), false);
  }
  if (!warnedEphemeral) {
    warnedEphemeral = true;
    if (!process.env.NODE_TEST_CONTEXT) {
      console.warn('[siteCompiler] EDGE_SIGNING_PRIVATE_KEY ausente: se usa una clave Ed25519 efímera (solo pruebas)');
    }
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return fromPrivateKey(privateKey, true);
};

/** Clave del proceso (cacheada). `reset` solo para tests. */
const getSigningKey = ({ reset = false } = {}) => {
  if (reset) cached = null;
  if (!cached) cached = loadSigningKey();
  return cached;
};

const signedPayload = (head) => {
  const out = {};
  for (const k of SIGNED_FIELDS) out[k] = head[k] === undefined ? null : head[k];
  return canonicalJson(out);
};

/** Devuelve una copia del head con `keyId` y `sig` (base64). */
const signHead = (head, key = getSigningKey()) => {
  const withKey = { ...head, keyId: key.keyId };
  const sig = crypto.sign(null, Buffer.from(signedPayload(withKey), 'utf8'), key.privateKey).toString('base64');
  return { ...withKey, sig };
};

/**
 * Verifica la firma de un head. `publicKey`: PEM, KeyObject o {publicKeyPem}.
 * Pensado para el edge (T5/T6) y la API (T4).
 */
const verifyHead = (head, publicKey) => {
  if (!head || typeof head.sig !== 'string' || !publicKey) return false;
  try {
    const keyObj = typeof publicKey === 'string'
      ? crypto.createPublicKey(publicKey)
      : (publicKey.publicKeyPem ? crypto.createPublicKey(publicKey.publicKeyPem) : publicKey);
    return crypto.verify(null, Buffer.from(signedPayload(head), 'utf8'), keyObj, Buffer.from(head.sig, 'base64'));
  } catch {
    return false;
  }
};

/** Lo que se publica a los equipos (sin la privada). */
const getSigningPublicKey = () => {
  const key = getSigningKey();
  return { alg: 'Ed25519', keyId: key.keyId, publicKeyPem: key.publicKeyPem, ephemeral: key.ephemeral };
};

module.exports = {
  SIGNED_FIELDS,
  loadSigningKey,
  getSigningKey,
  getSigningPublicKey,
  signHead,
  verifyHead,
  signedPayload
};
