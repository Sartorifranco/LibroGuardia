'use strict';

/**
 * Registro de controladores enrolados (hito 1: allowlist local en la config del hub) y
 * cliente LAN firmado hub → controlador.
 *
 * API del controlador (T5): POST /edge/config/notify, GET /edge/status,
 * POST /edge/doors/:id/open {requestedBy, reason, force}.
 *
 * Estado por controlador persistido en meta('hub_controllers_state'):
 *   { [deviceId]: { lastSeenAt, configVersionApplied, lastNotifyAt, lastNotifyOk, lastError } }
 */

const { readMeta, writeMeta } = require('../lib/db/migrations');
const { publicKeyFrom } = require('./keys');
const { signRequest } = require('./lanSignCompat');

class ControllerRegistry {
  /**
   * @param {{ db, controllers:Array<{deviceId:string, publicKey:string, url?:string, doorIds?:string[]}>,
   *           hubDeviceId:string, privateKey:any, fetch?:Function, timeoutMs?:number, now?:()=>number }} opts
   */
  constructor({ db, controllers = [], hubDeviceId, privateKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, now = () => Date.now() }) {
    this.db = db;
    this.hubDeviceId = hubDeviceId;
    this.privateKey = privateKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.byId = new Map();
    for (const c of controllers) {
      if (!c || !c.deviceId || !c.publicKey) continue;
      this.byId.set(String(c.deviceId), {
        deviceId: String(c.deviceId),
        publicKey: publicKeyFrom(c.publicKey),
        url: c.url ? String(c.url).replace(/\/+$/, '') : null,
        doorIds: Array.isArray(c.doorIds) ? c.doorIds.map(String) : null
      });
    }
    this.state = this.loadState();
  }

  loadState() {
    try { return JSON.parse(readMeta(this.db, 'hub_controllers_state') || '{}') || {}; } catch (_) { return {}; }
  }

  saveState() {
    writeMeta(this.db, 'hub_controllers_state', JSON.stringify(this.state));
  }

  patch(deviceId, fields) {
    this.state[deviceId] = { ...(this.state[deviceId] || {}), ...fields };
    this.saveState();
  }

  ids() { return [...this.byId.keys()]; }

  get(deviceId) { return this.byId.get(String(deviceId)) || null; }

  publicKeyFor(deviceId) {
    const c = this.byId.get(String(deviceId));
    return c ? c.publicKey : null;
  }

  markSeen(deviceId, { configVersionApplied } = {}) {
    const fields = { lastSeenAt: this.now() };
    if (Number.isFinite(Number(configVersionApplied)) && configVersionApplied !== null) {
      fields.configVersionApplied = Number(configVersionApplied);
    }
    this.patch(deviceId, fields);
  }

  /**
   * Controlador dueño de la puerta: `doors[].controllerId` del snapshot; si no, `doorIds` de la allowlist.
   */
  ownerOf(doorId, snapshot) {
    const door = snapshot && snapshot.door ? snapshot.door(doorId) : null;
    if (door && door.controllerId && this.byId.has(String(door.controllerId))) return this.byId.get(String(door.controllerId));
    for (const c of this.byId.values()) if (c.doorIds && c.doorIds.includes(String(doorId))) return c;
    return null;
  }

  async call(deviceId, method, path, body) {
    const c = this.get(deviceId);
    if (!c || !c.url) {
      const err = new Error(`Controlador ${deviceId} sin URL LAN`);
      err.code = 'CONTROLLER_NO_URL';
      throw err;
    }
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...signRequest({ method, path, body: text, deviceId: this.hubDeviceId, privateKey: this.privateKey, now: this.now() })
    };
    let res;
    try {
      res = await this.fetch(`${c.url}${path}`, {
        method, headers, body: body === undefined ? undefined : text, signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      const e = new Error(`Controlador ${deviceId} no responde: ${err.message}`);
      e.code = 'CONTROLLER_UNREACHABLE';
      throw e;
    }
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw }; }
    if (!res.ok) {
      const e = new Error(`Controlador ${deviceId} respondió ${res.status}`);
      e.code = (data && (data.code || data.error)) || `HTTP_${res.status}`;
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  }

  /** Avisa a todos (o a los atrasados) que hay config nueva. Nunca lanza. */
  async notifyConfig(version, { onlyLagging = false } = {}) {
    const results = {};
    for (const id of this.ids()) {
      const st = this.state[id] || {};
      if (onlyLagging && Number(st.configVersionApplied) >= version) continue;
      try {
        await this.call(id, 'POST', '/edge/config/notify', { version });
        this.patch(id, { lastNotifyAt: this.now(), lastNotifyOk: true, lastError: null });
        results[id] = 'ok';
      } catch (err) {
        this.patch(id, { lastNotifyAt: this.now(), lastNotifyOk: false, lastError: err.code || err.message });
        results[id] = err.code || 'error';
      }
    }
    return results;
  }

  /** GET /edge/status de cada controlador para conocer configVersionApplied. Nunca lanza. */
  async pollStatus() {
    for (const id of this.ids()) {
      try {
        const st = await this.call(id, 'GET', '/edge/status');
        const v = st && (st.configVersionApplied ?? st.configVersion);
        this.markSeen(id, { configVersionApplied: v ?? null });
        this.patch(id, { online: true, lastError: null });
      } catch (err) {
        this.patch(id, { online: false, lastError: err.code || err.message });
      }
    }
  }

  openDoor(deviceId, doorId, { requestedBy, reason, force = false }) {
    return this.call(deviceId, 'POST', `/edge/doors/${encodeURIComponent(doorId)}/open`, { requestedBy, reason, force: Boolean(force) });
  }

  /** Resumen para heartbeat/estado (sin claves). */
  summary(offlineAfterMs = 15000 * 4) {
    const out = {};
    const now = this.now();
    for (const id of this.ids()) {
      const st = this.state[id] || {};
      out[id] = {
        configVersionApplied: st.configVersionApplied ?? null,
        lastSeenAt: st.lastSeenAt ?? null,
        online: st.lastSeenAt ? now - st.lastSeenAt <= offlineAfterMs || st.online === true : st.online === true,
        lastError: st.lastError ?? null
      };
    }
    return out;
  }
}

module.exports = { ControllerRegistry };
