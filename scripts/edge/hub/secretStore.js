'use strict';

/**
 * Secretos del hub en la tabla `meta` del SQLite, cifrados con AES-256-GCM.
 * La clave se deriva (HKDF-SHA256) de la clave privada Ed25519 del equipo, que vive en un
 * archivo aparte (`privateKeyFile`): copiar solo la base no alcanza para usar el refresh token.
 */

const crypto = require('crypto');
const { readMeta, writeMeta } = require('../lib/db/migrations');
const { privateKeyFrom } = require('./keys');

class SecretStore {
  /**
   * @param {import('../lib/db/driver').Db} db
   * @param {any} privateKey clave Ed25519 del equipo (PEM / KeyObject)
   */
  constructor(db, privateKey) {
    this.db = db;
    const der = privateKeyFrom(privateKey).export({ format: 'der', type: 'pkcs8' });
    this.key = Buffer.from(crypto.hkdfSync('sha256', der, Buffer.from('mss-edge'), Buffer.from('hub-secret-store-v1'), 32));
  }

  set(name, value) {
    const metaKey = `secret:${name}`;
    if (value === null || value === undefined) {
      this.db.run('DELETE FROM meta WHERE key = ?', metaKey);
      return;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(metaKey));
    const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeMeta(this.db, metaKey, `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`);
  }

  /** @returns {string|null} null si no existe o no se puede descifrar (clave de equipo distinta). */
  get(name) {
    const metaKey = `secret:${name}`;
    const raw = readMeta(this.db, metaKey);
    if (!raw) return null;
    const [v, iv, tag, ct] = String(raw).split(':');
    if (v !== 'v1') return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(metaKey));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
    } catch (_) {
      return null;
    }
  }
}

module.exports = { SecretStore };
