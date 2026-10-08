'use strict';

/**
 * Runtime del hub de sitio (T6, hito 1). `mss-edge.js` lo usa con role=hub:
 *
 *   const { startHub } = require('./hub');
 *   const hub = await startHub(config);   // hub.stop() para cerrar
 *
 * Arma: SQLite (openEdgeDb role 'hub') + cliente nube (token con rotación de refresh token)
 * + sync de config (CloudHeadSource poll 60 s) + servidor LAN (eventos/config para controladores,
 * /api/runtime, estáticos) + subida de eventos (≤200, cada 2 min / alarma ya) + comandos remotos
 * + resumen vivo (≤1/min si cambió) + heartbeat (5 min).
 */

const fs = require('fs');
const path = require('path');
const { openEdgeDb } = require('../lib/db');
const { privateKeyFrom } = require('./keys');
const { SecretStore } = require('./secretStore');
const { CloudClient } = require('./cloudClient');
const { ControllerRegistry } = require('./controllers');
const { ConfigSync, PollHeadSource } = require('./configSync');
const { EventUploader } = require('./eventUploader');
const { LiveState } = require('./liveState');
const { CommandRouter } = require('./commands');
const { LanVerifier } = require('./lanSignCompat');
const { createLanServer } = require('./lanServer');
const { makeHeadVerifier } = require('./headSignature');

const DEFAULTS = {
  siteId: 'principal',
  dataDir: './data',
  lan: { host: '0.0.0.0', port: 8080, staticDir: null, publicUrl: null },
  cloud: {
    baseUrl: null,
    refreshToken: null,
    headPublicKeys: {},
    allowUnsignedHeads: false,
    headPollMs: 60 * 1000,
    eventsIntervalMs: 2 * 60 * 1000,
    commandsPollMs: 10 * 1000,
    liveMinIntervalMs: 60 * 1000,
    heartbeatMs: 5 * 60 * 1000,
    timeoutMs: 15000
  },
  controllers: [],
  retentionDays: 90
};

/** Normaliza la config (rutas relativas al archivo de config si se pasa `baseDir`). */
function normalizeConfig(raw = {}, { baseDir = process.cwd() } = {}) {
  const cfg = {
    ...DEFAULTS,
    ...raw,
    lan: { ...DEFAULTS.lan, ...(raw.lan || {}) },
    cloud: { ...DEFAULTS.cloud, ...(raw.cloud || {}) },
    controllers: Array.isArray(raw.controllers) ? raw.controllers : []
  };
  if (!cfg.deviceId) throw new Error('config del hub: falta deviceId');
  const abs = (p) => (p ? path.resolve(baseDir, p) : p);
  cfg.dataDir = abs(cfg.dataDir);
  cfg.dbFile = cfg.dbFile ? abs(cfg.dbFile) : path.join(cfg.dataDir, 'hub.db');
  if (cfg.privateKeyFile) cfg.privateKeyFile = abs(cfg.privateKeyFile);
  if (cfg.lan.staticDir) cfg.lan.staticDir = abs(cfg.lan.staticDir);
  if (cfg.cloud.baseUrl) cfg.cloud.baseUrl = String(cfg.cloud.baseUrl).replace(/\/+$/, '').replace(/\/api$/, '');
  return cfg;
}

function loadPrivateKey(cfg) {
  if (cfg.privateKey) return privateKeyFrom(cfg.privateKey);
  if (cfg.privateKeyFile && fs.existsSync(cfg.privateKeyFile)) return privateKeyFrom(fs.readFileSync(cfg.privateKeyFile, 'utf8'));
  throw new Error(`config del hub: no se encontró la clave privada del equipo (${cfg.privateKeyFile || 'privateKeyFile'})`);
}

class Hub {
  /**
   * @param {object} config ya normalizada
   * @param {{ fetch?:Function, now?:()=>number, log?:object, headSource?:object }} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.deviceId = config.deviceId;
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || console;
    const fetchImpl = deps.fetch || globalThis.fetch;
    this.privateKey = loadPrivateKey(config);

    this.edge = openEdgeDb(config.dbFile, { role: 'hub', deviceId: config.deviceId });
    if (this.edge.recovered) this.log.error(`[hub] base corrupta apartada en ${this.edge.movedTo}; se baja la config completa`);

    this.secrets = new SecretStore(this.edge.db, this.privateKey);
    this.client = config.cloud.baseUrl ? new CloudClient({
      baseUrl: config.cloud.baseUrl,
      deviceId: config.deviceId,
      privateKey: this.privateKey,
      secrets: this.secrets,
      bootstrapRefreshToken: config.cloud.refreshToken,
      fetch: fetchImpl,
      timeoutMs: config.cloud.timeoutMs,
      now: this.now,
      log: this.log
    }) : null;

    this.controllers = new ControllerRegistry({
      db: this.edge.db, controllers: config.controllers, hubDeviceId: config.deviceId,
      privateKey: this.privateKey, fetch: fetchImpl, now: this.now
    });
    this.verifyHead = makeHeadVerifier(config.cloud.headPublicKeys, { allowUnsigned: config.cloud.allowUnsignedHeads === true });
    this.configSync = new ConfigSync({
      edge: this.edge, client: this.client, controllers: this.controllers, verifyHead: this.verifyHead, log: this.log, now: this.now
    });
    this.uploader = this.client ? new EventUploader({
      edge: this.edge, client: this.client, hubId: config.deviceId, intervalMs: config.cloud.eventsIntervalMs, log: this.log, now: this.now
    }) : null;
    this.live = new LiveState({
      edge: this.edge, client: this.client, controllers: this.controllers, minIntervalMs: config.cloud.liveMinIntervalMs, log: this.log, now: this.now
    });
    this.commands = this.client ? new CommandRouter({
      edge: this.edge, client: this.client, controllers: this.controllers, hubId: config.deviceId,
      intervalMs: config.cloud.commandsPollMs, log: this.log, now: this.now
    }) : null;
    this.headSource = deps.headSource || (this.client ? new PollHeadSource({ client: this.client, intervalMs: config.cloud.headPollMs, log: this.log }) : null);
    if (this.headSource && !this.headSource.onHead) this.headSource.onHead = (head, extras) => this.onHead(head, extras);
    this.verifier = new LanVerifier({ publicKeyFor: (id) => this.controllers.publicKeyFor(id), now: this.now });
    this.server = null;
    this.heartbeatTimer = null;
    this.lastHeartbeat = null;
  }

  /** Callback del CloudHeadSource. */
  async onHead(head, extras = {}) {
    if (this.commands) {
      this.commands.setHint(extras.pendingCommands);
      if (extras.pendingCommands > 0) this.commands.poll().catch(() => {});
    }
    return this.configSync.handleHead(head);
  }

  /**
   * Ingesta de un push de controlador (ya autenticado). Idempotente.
   * @returns {{ackSeq:number|null, inserted:number, duplicates:number}}
   */
  ingestFromController(deviceId, data = {}) {
    const raw = Array.isArray(data.events) ? data.events : [];
    const events = raw.map((e) => {
      if (e && e.deviceId && String(e.deviceId) !== deviceId) {
        throw Object.assign(new Error(`evento de ${e.deviceId} enviado por ${deviceId}`), { code: 'DEVICE_MISMATCH' });
      }
      return { ...e, deviceId };
    });
    // Qué ids ya estaban (para alimentar el estado vivo solo con los nuevos).
    const known = new Set();
    const ids = events.map((e) => `${deviceId}:${Number(e.seq)}`);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of this.edge.db.all(`SELECT id FROM events WHERE id IN (${part.map(() => '?').join(',')})`, ...part)) known.add(r.id);
    }
    const res = this.edge.journal.ingest(events);
    const fresh = [];
    const seen = new Set();
    events.forEach((e, i) => {
      if (known.has(ids[i]) || seen.has(ids[i])) return;
      seen.add(ids[i]);
      fresh.push({ ...e, id: ids[i] });
    });
    const alarm = fresh.length ? this.live.applyEvents(fresh) : false;
    this.controllers.markSeen(deviceId, { configVersionApplied: data.configVersionApplied ?? null });
    if (alarm) {
      if (this.uploader) this.uploader.kick();
      this.live.maybePost().catch(() => {});
    }
    return { ackSeq: res.ackSeqByDevice[deviceId] ?? null, inserted: res.inserted, duplicates: res.duplicates };
  }

  async heartbeat() {
    await this.controllers.pollStatus();
    const version = this.configSync.configVersion();
    if (version > 0) await this.controllers.notifyConfig(version, { onlyLagging: true });
    try {
      this.edge.journal.purge({ retentionDays: this.config.retentionDays });
    } catch (err) {
      this.log.warn(`[hub] purge: ${err.message}`);
    }
    if (!this.client) return null;
    const payload = {
      hubId: this.deviceId,
      siteId: this.config.siteId,
      configVersionApplied: version,
      controllers: this.controllers.summary(),
      checks: {
        db: 'ok',
        events: this.uploader ? this.uploader.status() : null,
        lastConfigSync: this.configSync.lastResult,
        clockMs: this.now()
      },
      lanUrl: this.config.lan.publicUrl || null
    };
    try {
      await this.client.heartbeat(payload);
      this.lastHeartbeat = { at: this.now(), ok: true };
    } catch (err) {
      this.lastHeartbeat = { at: this.now(), ok: false, error: err.code || err.message };
    }
    return payload;
  }

  status() {
    return {
      role: 'hub',
      deviceId: this.deviceId,
      siteId: this.config.siteId,
      configVersion: this.configSync.configVersion(),
      cloudOnline: this.client ? this.client.online : null,
      events: this.uploader ? this.uploader.status() : { pending: this.edge.journal.stats().pending },
      controllers: this.controllers.summary(),
      lastHeartbeat: this.lastHeartbeat
    };
  }

  /** Levanta el servidor LAN. `port` 0 = efímero (tests). */
  listen(port = this.config.lan.port, host = this.config.lan.host) {
    this.server = createLanServer({ hub: this, verifier: this.verifier, staticDir: this.config.lan.staticDir, log: this.log });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve(this.server.address());
      });
    });
  }

  /** Arranca timers (sin timers en tests: se llaman los métodos a mano). */
  startLoops() {
    if (this.headSource) this.headSource.start((head, extras) => this.onHead(head, extras));
    if (this.uploader) this.uploader.start();
    if (this.commands) this.commands.start();
    if (this.client) this.live.start();
    const hb = () => this.heartbeat().catch((err) => this.log.warn(`[hub] heartbeat: ${err.message}`));
    this.heartbeatTimer = setInterval(hb, this.config.cloud.heartbeatMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    setTimeout(hb, 5000).unref();
  }

  async stop() {
    if (this.headSource) this.headSource.stop();
    if (this.uploader) this.uploader.stop();
    if (this.commands) this.commands.stop();
    this.live.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.server) {
      const s = this.server;
      this.server = null;
      const closed = new Promise((resolve) => s.close(() => resolve()));
      if (s.closeAllConnections) s.closeAllConnections();
      await closed;
    }
    // Esperar operaciones en curso antes de cerrar la base.
    await Promise.allSettled([
      this.configSync.busy, this.uploader && this.uploader.running, this.commands && this.commands.running, this.live.posting
    ].filter(Boolean));
    this.edge.db.close();
  }
}

/**
 * Arranca el hub completo (servidor LAN + loops).
 * @param {object} config objeto de config (ver config.ejemplo.json) o ya normalizada
 * @param {object} [deps] inyección para tests
 */
async function startHub(config, deps = {}) {
  const cfg = config && config.dbFile ? config : normalizeConfig(config, { baseDir: deps.baseDir });
  const hub = new Hub(cfg, deps);
  if (!cfg.cloud.baseUrl) hub.log.warn('[hub] sin cloud.baseUrl: modo solo-LAN (sin sync de config ni subida de eventos)');
  const addr = await hub.listen();
  hub.log.info(`[hub] ${cfg.deviceId} escuchando en ${addr.address}:${addr.port} (config v${hub.configSync.configVersion()})`);
  if (deps.loops !== false) hub.startLoops();
  return hub;
}

module.exports = { startHub, Hub, normalizeConfig, DEFAULTS };
