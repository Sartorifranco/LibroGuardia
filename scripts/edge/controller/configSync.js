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
 *
 * Clave HMAC de credenciales del sitio: viaja en el chunk `secrets` del bundle firmado y la guarda
 * el ChunkStore como cualquier otro chunk (todo-o-nada: sin ella un sitio con clave no reconoce
 * ningún DNI, así que se sigue con la config anterior). El motor la lee de `snap.credentialKey()`.
 * Si el hub no la entrega → alarma `credential_key_missing` (una vez por versión).
 * TODO fase 2: chunk cifrado a la clave del equipo.
 */

const { ChunkHashError } = require('../lib/db/chunkStore');
const { nullLogger } = require('../drivers/logger');

/** Metas de la versión anterior (clave guardada aparte); se limpian al aplicar config nueva. */
const LEGACY_META_KEYS = ['controller_credential_key', 'controller_credential_key_chunk_hash'];

class ConfigSync {
  /**
   * @param {{edge:{db:object, chunks:object, snapshot:object}, hub:{getHead:Function, getChunks:Function},
   *          verifyHead:(head)=>boolean, journal?:(evt:object)=>void, logger?:object, onApplied?:(result)=>void}} opts
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
    this.status = { lastAttemptAt: null, lastOkAt: null, lastResult: null, lastError: null, appliedVersion: edge.chunks.configVersion() };
  }

  /** Clave HMAC vigente (null = sitio sin clave o todavía no recibida). */
  credentialKey() {
    const s = this.edge.snapshot;
    return typeof s.credentialKey === 'function' ? s.credentialKey() : null;
  }

  credentialKeyStatus(head = null) {
    const declared = head ? Boolean(head.chunks && head.chunks.secrets) : Boolean(this.edge.chunks.getChunk('secrets'));
    return { present: Boolean(this.credentialKey()), declared };
  }

  /** Alarma (una vez por versión) si el head declara `secrets` y no hay clave utilizable. */
  checkSecrets(head, { missing = false } = {}) {
    const meta = head && head.chunks && head.chunks.secrets;
    if (!meta) return;
    if (!missing && this.credentialKey()) {
      this.lastKeyAlarm = null;
      return;
    }
    const tag = `${head.version}|${meta.hash}`;
    if (this.lastKeyAlarm === tag) return;
    this.lastKeyAlarm = tag;
    this.logger.error('El bundle usa clave de credenciales pero el hub no entregó el chunk "secrets": se sigue con la config anterior');
    this.journal({ type: 'alarm', reason: 'credential_key_missing', payload: { state: 'raised', version: Number(head.version) } });
  }

  /** Compatibilidad con `--import-bundle` (antes la clave se aplicaba aparte). */
  applySecrets(head) {
    this.checkSecrets(head);
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
      const bodies = {};
      if (names.length) {
        const res = await this.hub.getChunks(names);
        for (const [name, entry] of Object.entries((res && res.chunks) || {})) {
          // Hub: {v, hash, body}. También se acepta el cuerpo pelado.
          bodies[name] = entry && typeof entry === 'object' && 'body' in entry && 'hash' in entry ? entry.body : entry;
        }
      }
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
      if (r.applied) {
        for (const k of LEGACY_META_KEYS) this.edge.db.run('DELETE FROM meta WHERE key = ?', k);
        this.edge.snapshot.refresh();
        this.checkSecrets(head);
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
      if (r.reason === 'missing_chunks' && (r.missing || []).includes('secrets')) this.checkSecrets(head, { missing: true });
      return this.reject(head, r.reason, r.missing ? { missing: r.missing } : {});
    }
    return { applied: false, reason: 'head_inestable' };
  }
}

module.exports = { ConfigSync };
