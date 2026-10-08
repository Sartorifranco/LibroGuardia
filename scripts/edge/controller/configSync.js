'use strict';

/**
 * Sincronización de config hub → controlador (docs/ETAPA2-DISENO.md §4).
 *
 * Disparo: `POST /edge/config/notify` del hub, al arrancar y cada configPollMs.
 * 1. GET /edge/config/head. Se verifica la firma Ed25519 de la NUBE (clave fijada en la config
 *    local) antes de bajar nada: el hub solo reparte, no puede inventar derechos.
 * 2. needsChunks(head) → GET /edge/config/chunks?names=… (solo los que cambiaron).
 *    Si el hub cambió de head entre ambas requests (hash distinto / faltante) se reintenta (máx. 3).
 * 3. chunkStore.applyHead(head, cuerpos): hash por chunk, todo-o-nada, configVersion monotónico
 *    (una versión vieja se rechaza con reason 'stale').
 * Cada aplicación o rechazo queda en el journal (config_applied / config_rejected).
 */

const { ChunkHashError, hashBody } = require('../lib/db/chunkStore');
const { readMeta, writeMeta } = require('../lib/db/migrations');
const { nullLogger } = require('../drivers/logger');

const META_KEY = 'controller_credential_key';
const META_KEY_HASH = 'controller_credential_key_chunk_hash';
const normHash = (h) => (h ? String(h).replace(/^sha256:/i, '').toLowerCase() : null);

/**
 * Clave HMAC de credenciales del sitio (chunk 'secrets' del bundle firmado; ver siteCompiler/README).
 * El ChunkStore no guarda ese chunk: el controlador lo baja aparte, verifica su hash contra el head
 * firmado y guarda solo la clave en meta. TODO fase 2: chunk cifrado a la clave del equipo.
 */
class CredentialKeyStore {
  constructor(db) {
    this.db = db;
    this.cache = undefined;
  }

  get() {
    if (this.cache === undefined) this.cache = readMeta(this.db, META_KEY) || null;
    return this.cache;
  }

  chunkHash() {
    return readMeta(this.db, META_KEY_HASH) || null;
  }

  set(key, chunkHash) {
    writeMeta(this.db, META_KEY, key || '');
    writeMeta(this.db, META_KEY_HASH, chunkHash || '');
    this.cache = key || null;
  }
}

class ConfigSync {
  /**
   * @param {{edge:{chunks:object, snapshot:object}, hub:{getChunks:Function}, verifyHead:(head)=>boolean,
   *          journal?:(evt:object)=>void, logger?:object, onApplied?:(result)=>void}} opts
   */
  constructor({ edge, hub, verifyHead, journal = () => {}, logger = nullLogger, onApplied = () => {} }) {
    this.edge = edge;
    this.hub = hub;
    this.verifyHead = verifyHead;
    this.journal = journal;
    this.logger = logger;
    this.onApplied = onApplied;
    this.running = null;
    this.again = false;
    this.lastRejectKey = null;
    this.lastKeyAlarm = null;
    this.keys = new CredentialKeyStore(edge.db);
    this.status = { lastAttemptAt: null, lastOkAt: null, lastResult: null, lastError: null, appliedVersion: edge.chunks.configVersion() };
  }

  /** Clave HMAC vigente (null = sitio sin clave o todavía no recibida). */
  credentialKey() {
    return this.keys.get();
  }

  credentialKeyStatus(head = null) {
    const declared = head ? Boolean(head.chunks && head.chunks.secrets) : Boolean(this.keys.chunkHash());
    return { present: Boolean(this.keys.get()), declared };
  }

  /**
   * Después de aplicar (o si ya estaba al día): guarda la clave del chunk 'secrets' si vino y su
   * hash coincide con el head firmado; si el head la declara y no llegó → alarma (una vez por versión).
   */
  applySecrets(head, secretsBody) {
    const meta = head.chunks && head.chunks.secrets;
    if (!meta) {
      if (this.keys.get()) this.keys.set(null, null);
      return;
    }
    const want = normHash(meta.hash);
    if (secretsBody !== undefined && secretsBody !== null) {
      if (hashBody(secretsBody) !== want) {
        this.logger.error('Chunk secrets con hash distinto al del head firmado: se ignora');
      } else {
        const key = secretsBody.secrets ? secretsBody.secrets.credentialKey : secretsBody.credentialKey;
        if (key) {
          this.keys.set(String(key), want);
          this.lastKeyAlarm = null;
          return;
        }
      }
    }
    if (this.keys.chunkHash() === want && this.keys.get()) return;
    const tag = `${head.version}|${want}`;
    if (this.lastKeyAlarm !== tag) {
      this.lastKeyAlarm = tag;
      this.logger.error('El bundle usa clave de credenciales pero el hub no entregó el chunk "secrets": los DNI/QR no van a coincidir');
      this.journal({ type: 'alarm', reason: 'credential_key_missing', payload: { state: 'raised', version: Number(head.version) } });
    }
  }

  reject(head, reason, extra = {}) {
    const version = head && Number(head.version);
    const key = `${version}|${reason}`;
    this.status.lastResult = { applied: false, reason, version };
    if (key !== this.lastRejectKey) {
      this.lastRejectKey = key;
      this.logger.warn('Config rechazada', { version, reason, ...extra });
      this.journal({ type: 'config_rejected', reason, payload: { version, current: this.edge.chunks.configVersion(), ...extra } });
    }
    return { applied: false, reason, version };
  }

  /** Sincroniza (si ya hay una en curso, encola una más y devuelve la misma promesa). */
  sync(trigger = 'poll') {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let result;
      do {
        this.again = false;
        result = await this.syncOnce(trigger).catch((err) => {
          this.status.lastError = err.message;
          this.logger.warn('Sync de config falló', { error: err.message, code: err.code });
          return { applied: false, reason: 'error', error: err.message };
        });
      } while (this.again);
      this.running = null;
      return result;
    })();
    return this.running;
  }

  async syncOnce(trigger) {
    this.status.lastAttemptAt = Date.now();
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const head = await this.hub.getHead();
      if (head === null) {
        this.status.lastResult = { applied: false, reason: 'hub_sin_config' };
        return this.status.lastResult;
      }
      if (!head || !Number.isFinite(Number(head.version))) return this.reject(head, 'invalid_head');
      if (!this.verifyHead(head)) return this.reject(head, 'bad_signature');
      const current = this.edge.chunks.configVersion();
      if (Number(head.version) < current) return this.reject(head, 'stale');
      const names = this.edge.chunks.needsChunks(head);
      const secretsMeta = head.chunks && head.chunks.secrets;
      const wantSecrets = Boolean(secretsMeta)
        && (!this.keys.get() || this.keys.chunkHash() !== normHash(secretsMeta.hash));
      const ask = wantSecrets ? [...names, 'secrets'] : names;
      const bodies = {};
      if (ask.length) {
        const res = await this.hub.getChunks(ask);
        for (const [name, entry] of Object.entries((res && res.chunks) || {})) {
          // Hub: {v, hash, body}. También se acepta el cuerpo pelado.
          bodies[name] = entry && typeof entry === 'object' && 'body' in entry && 'hash' in entry ? entry.body : entry;
        }
      }
      const secretsBody = bodies.secrets;
      delete bodies.secrets;
      let r;
      try {
        r = this.edge.chunks.applyHead(head, bodies);
      } catch (err) {
        if (err instanceof ChunkHashError || err.code === 'CHUNK_HASH_MISMATCH') {
          // Puede ser que el hub haya cambiado de head entre las dos requests: se reintenta.
          if (attempt < MAX_ATTEMPTS) continue;
          return this.reject(head, 'hash_mismatch', { chunk: err.chunk });
        }
        throw err;
      }
      this.status.lastOkAt = Date.now();
      this.status.lastError = null;
      if (r.applied || r.reason === 'up_to_date') this.applySecrets(head, secretsBody);
      if (r.applied) {
        this.edge.snapshot.refresh();
        this.status.appliedVersion = r.version;
        this.status.lastResult = r;
        this.lastRejectKey = null;
        this.logger.info('Config aplicada', { version: r.version, changed: r.changed, removed: r.removed, trigger });
        this.journal({ type: 'config_applied', reason: 'config_aplicada', payload: { version: r.version, changed: r.changed, removed: r.removed } });
        this.onApplied(r);
        return r;
      }
      if (r.reason === 'up_to_date') {
        this.status.lastResult = r;
        return r;
      }
      if (r.reason === 'missing_chunks' && attempt < MAX_ATTEMPTS) continue;
      return this.reject(head, r.reason, r.missing ? { missing: r.missing } : {});
    }
    return { applied: false, reason: 'head_inestable' };
  }
}

module.exports = { ConfigSync, CredentialKeyStore };
