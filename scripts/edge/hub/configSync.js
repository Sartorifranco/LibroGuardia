'use strict';

/**
 * Sincronización de configuración nube → hub → controladores.
 *
 * - `CloudHeadSource` es la interfaz enchufable de origen del head:
 *     start(onHead) / stop() / pollNow()  — onHead(head, extras) con extras = { pendingCommands? }
 *   Hito 1: `PollHeadSource` (GET /api/edge/v1/head cada 60 s).
 *   Fase 2: listener Firestore `onSnapshot(sites/{s}/compiled/head)` con custom token (sin deps ahora).
 * - `ConfigSync.handleHead(head)`: verifica firma → baja SOLO los chunks con hash distinto →
 *   `chunkStore.applyHead` (todo-o-nada, versión monotónica) → guarda el head firmado para
 *   servirlo a los controladores → `POST /edge/config/notify` a cada controlador.
 */

const { readMeta, writeMeta } = require('../lib/db/migrations');

const MAX_NAMES_PER_REQUEST = 25;

class PollHeadSource {
  /**
   * @param {{ client:import('./cloudClient').CloudClient, intervalMs?:number, log?:object }} opts
   */
  constructor({ client, intervalMs = 60 * 1000, log = console }) {
    this.client = client;
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.onHead = null;
    this.running = null;
  }

  /** Normaliza la respuesta: `{head, pendingCommands}` o el head directo. */
  static parse(res) {
    if (!res || typeof res !== 'object') return { head: null, extras: {} };
    const head = res.head && typeof res.head === 'object' ? res.head : res;
    const pc = res.pendingCommands ?? head.pendingCommands;
    return { head, extras: { pendingCommands: Number.isFinite(Number(pc)) && pc !== null ? Number(pc) : undefined } };
  }

  async pollNow() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const { head, extras } = PollHeadSource.parse(await this.client.getHead());
        if (head && this.onHead) await this.onHead(head, extras);
        return head;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  start(onHead) {
    this.onHead = onHead;
    const tick = () => this.pollNow().catch((err) => this.log.warn(`[hub] head: ${err.message}`));
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Normaliza la respuesta de /chunks a { name: body }. */
function normalizeChunks(res) {
  const src = res && res.chunks !== undefined ? res.chunks : res;
  const out = {};
  if (Array.isArray(src)) {
    for (const c of src) if (c && c.name) out[c.name] = c.body;
    return out;
  }
  for (const [name, val] of Object.entries(src || {})) {
    out[name] = val && typeof val === 'object' && 'body' in val && ('hash' in val || 'v' in val) ? val.body : val;
  }
  return out;
}

class ConfigSync {
  /**
   * @param {{ edge:{db, chunks, snapshot}, client, controllers:import('./controllers').ControllerRegistry,
   *           verifyHead:(head)=>boolean, log?:object, now?:()=>number }} opts
   */
  constructor({ edge, client, controllers, verifyHead, log = console, now = () => Date.now() }) {
    this.edge = edge;
    this.client = client;
    this.controllers = controllers;
    this.verifyHead = verifyHead;
    this.log = log;
    this.now = now;
    this.busy = null;
    this.lastResult = null;
    this.stats = { fetchedChunks: 0, rejectedHeads: 0 };
  }

  /** Head que se sirve a los controladores (el último aplicado, con su firma). */
  servedHead() {
    const raw = readMeta(this.edge.db, 'hub_head_json');
    return raw ? JSON.parse(raw) : null;
  }

  configVersion() {
    return this.edge.chunks.configVersion();
  }

  handleHead(head) {
    // Serializa: si llegan dos heads seguidos, el segundo espera al primero.
    const run = async () => this.apply(head);
    this.busy = (this.busy || Promise.resolve()).then(run, run);
    return this.busy;
  }

  async apply(head) {
    const result = await this.applyInner(head);
    this.lastResult = { ...result, at: this.now() };
    return result;
  }

  async applyInner(head) {
    if (!head || !Number.isFinite(Number(head.version))) return { applied: false, reason: 'invalid_head' };
    if (!this.verifyHead(head)) {
      this.stats.rejectedHeads += 1;
      this.log.error(`[hub] head v${head.version} con firma inválida: se ignora`);
      return { applied: false, reason: 'bad_signature' };
    }
    const current = this.configVersion();
    if (Number(head.version) < current) return { applied: false, reason: 'stale', current };

    const need = this.edge.chunks.needsChunks(head);
    const bodies = {};
    for (let i = 0; i < need.length; i += MAX_NAMES_PER_REQUEST) {
      const names = need.slice(i, i + MAX_NAMES_PER_REQUEST);
      const got = normalizeChunks(await this.client.getChunks(names));
      for (const n of names) {
        if (got[n] === undefined) return { applied: false, reason: 'chunk_missing_in_cloud', missing: [n] };
        bodies[n] = got[n];
      }
      this.stats.fetchedChunks += names.length;
    }

    let res;
    try {
      res = this.edge.chunks.applyHead(head, bodies);
    } catch (err) {
      if (err.code === 'CHUNK_HASH_MISMATCH') {
        this.log.error(`[hub] ${err.message}`);
        return { applied: false, reason: 'hash_mismatch', chunk: err.chunk };
      }
      throw err;
    }
    if (!res.applied && res.reason !== 'up_to_date') return { ...res, fetched: need };
    const headToServe = { ...head };
    delete headToServe.pendingCommands;
    writeMeta(this.edge.db, 'hub_head_json', JSON.stringify(headToServe));
    if (res.applied) {
      this.edge.snapshot.refresh();
      this.log.info(`[hub] config v${res.version} aplicada (${res.changed.length} chunks cambiados, ${need.length} bajados)`);
      await this.controllers.notifyConfig(Number(head.version));
    }
    return { ...res, fetched: need };
  }

  /** Cuerpos para GET /edge/config/chunks (el controlador no recibe `operators`). */
  chunksForController(names) {
    const head = this.servedHead();
    const out = {};
    for (const name of names) {
      if (name === 'operators') continue;
      if (head && !(head.chunks || {})[name]) continue;
      const c = this.edge.chunks.getChunk(name);
      if (c) out[name] = { v: c.version, hash: c.hash, body: c.body };
    }
    return out;
  }
}

module.exports = { ConfigSync, PollHeadSource, normalizeChunks };
