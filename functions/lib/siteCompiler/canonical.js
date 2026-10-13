'use strict';

/**
 * JSON canónico y hash de chunks. Copia exacta de `canonicalJson`/`hashBody` de
 * scripts/edge/lib/db/chunkStore.js (T3): el edge recalcula el mismo sha256 y lo
 * compara con `head.chunks[name].hash`.
 */

const crypto = require('node:crypto');

/** Claves ordenadas, sin espacios, `undefined` omitido (igual que JSON.stringify). */
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
};

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/** sha256 hex del JSON canónico de un body (objeto o string JSON). */
const chunkHash = (body) => sha256Hex(canonicalJson(typeof body === 'string' ? JSON.parse(body) : body));

module.exports = { canonicalJson, sha256Hex, chunkHash };
