'use strict';

/**
 * Verificación de la firma Ed25519 del head compilado por la nube (`sites/{s}/compiled/head`).
 *
 * Contrato asumido (alinear con T2 `functions/lib/siteCompiler`):
 *   head = { version, chunks:{name:{v,hash}}, sig, keyId, ... }
 *   sig  = base64( Ed25519( canonicalJson({ version, chunks }) ) ) con la clave `keyId` de la nube.
 * Los hashes de cada chunk (sha256 del JSON canónico) los verifica `ChunkStore` al aplicar,
 * así que firmar {version, chunks} cubre todo el bundle.
 *
 * Un hub comprometido no puede inventar derechos: los controladores verifican la misma firma
 * con las mismas claves públicas de la nube.
 */

const { canonicalJson } = require('../lib/db/chunkStore');
const { verify } = require('./keys');

function signedPayload(head) {
  return canonicalJson({ version: Number(head.version), chunks: head.chunks || {} });
}

/**
 * @param {Object<string,string>} publicKeys keyId → clave pública (PEM / base64 raw)
 * @param {{ allowUnsigned?: boolean }} [opts] solo para banco sin compilador firmando
 * @returns {(head:object)=>boolean}
 */
function makeHeadVerifier(publicKeys = {}, { allowUnsigned = false } = {}) {
  const keys = publicKeys || {};
  return function verifyHead(head) {
    if (!head || typeof head !== 'object') return false;
    if (allowUnsigned) return true;
    const key = keys[head.keyId] || (Object.keys(keys).length === 1 && !head.keyId ? Object.values(keys)[0] : null);
    if (!key || !head.sig) return false;
    return verify(key, signedPayload(head), head.sig);
  };
}

module.exports = { makeHeadVerifier, signedPayload };
