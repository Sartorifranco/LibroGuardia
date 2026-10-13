'use strict';

/**
 * Compilador por sitio (Etapa 2, T2). Ver README.md.
 *
 * Contrato para T4 (routes/edge.js) y T6 (hub):
 *   getHead(siteId)                 → head firmado (compila antes si hay cambios pendientes)
 *   getChunks(siteId, names)        → { name: body }   (getChunkDocs → con v/hash/json)
 *   Firma: Ed25519 sobre canonicalJson({version, chunks}) (./canonical.js), head.keyId + head.sig (base64)
 *   compileSite(siteId, {full})     → { head, version, changed, removed, mode }
 *   getSigningPublicKey()           → { alg:'Ed25519', keyId, publicKeyPem, ephemeral }
 *   verifyHead(head, publicKeyPem)  → boolean
 * Para las rutas que mutan datos:
 *   markDirty({people|auths|visitas: ids, doors|operators|full: true})   (nunca rechaza)
 * Para la nube:
 *   getCloudSnapshot(siteId)        → SnapLookup en memoria (+ version(), head())
 *   compileDirtySites()             → para colgar de un scheduler existente
 */

const { createSiteCompiler, DEFAULT_SITE_ID, defaultSiteId, COMPILER_VERSION } = require('./compiler');
const signing = require('./signing');
const { canonicalJson, chunkHash } = require('./canonical');
const build = require('./build');

const instance = createSiteCompiler();

module.exports = {
  getHead: instance.getHead,
  getChunks: instance.getChunks,
  getChunkDocs: instance.getChunkDocs,
  compileSite: instance.compileSite,
  compileDirtySites: instance.compileDirtySites,
  markDirty: instance.markDirty,
  getCloudSnapshot: instance.getCloudSnapshot,
  getSigningPublicKey: instance.getSigningPublicKey,
  loadCredentialKey: instance.loadCredentialKey,
  verifyHead: signing.verifyHead,
  signHead: signing.signHead,
  canonicalJson,
  chunkHash,
  bucketOf: build.bucketOf,
  chunkNameForPerson: build.chunkNameForPerson,
  createSiteCompiler,
  COMPILER_VERSION,
  DEFAULT_SITE_ID,
  defaultSiteId,
  _instance: instance
};
