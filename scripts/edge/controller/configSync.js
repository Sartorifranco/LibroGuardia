'use strict';

/**
 * Sincronización de config hub → controlador (docs/ETAPA2-DISENO.md §4).
 *
 * Disparo: `POST /edge/config/notify` del hub, al arrancar y cada configPollMs.
 * 1. GET /edge/config/chunks → head. Se verifica la firma Ed25519 de la NUBE (clave fijada en la
 *    config local) antes de bajar nada: el hub solo reparte, no puede inventar derechos.
 * 2. needsChunks(head) → GET /edge/config/chunks?names=… (solo los que cambiaron).
 * 3. chunkStore.applyHead(head, cuerpos): hash por chunk, todo-o-nada, configVersion monotónico
 *    (una versión vieja se rechaza con reason 'stale').
 * Cada aplicación o rechazo queda en el journal (config_applied / config_rejected).
 */

const { ChunkHashError } = require('../lib/db/chunkStore');
const { nullLogger } = require('../drivers/logger');

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
    this.status = { lastAttemptAt: null, lastOkAt: null, lastResult: null, lastError: null, appliedVersion: edge.chunks.configVersion() };
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = await this.hub.getChunks([]);
      const head = first && first.head;
      if (!head || !Number.isFinite(Number(head.version))) return this.reject(head, 'invalid_head');
      if (!this.verifyHead(head)) return this.reject(head, 'bad_signature');
      const current = this.edge.chunks.configVersion();
      if (Number(head.version) < current) return this.reject(head, 'stale');
      const names = this.edge.chunks.needsChunks(head);
      let bodies = {};
      if (names.length) {
        const res = await this.hub.getChunks(names);
        if (!res || !res.head || Number(res.head.version) !== Number(head.version)) {
          this.logger.info('El head cambió mientras se bajaban chunks; reintento');
          continue;
        }
        bodies = res.chunks || {};
      }
      let r;
      try {
        r = this.edge.chunks.applyHead(head, bodies);
      } catch (err) {
        if (err instanceof ChunkHashError || err.code === 'CHUNK_HASH_MISMATCH') return this.reject(head, 'hash_mismatch', { chunk: err.chunk });
        throw err;
      }
      this.status.lastOkAt = Date.now();
      this.status.lastError = null;
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
      return this.reject(head, r.reason, r.missing ? { missing: r.missing } : {});
    }
    return { applied: false, reason: 'head_inestable' };
  }
}

module.exports = { ConfigSync };
