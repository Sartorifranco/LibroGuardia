'use strict';

/**
 * Estado vivo del sitio en el hub, derivado de los eventos que suben los controladores
 * (persistido en SQLite: `presence`, `alarms`, `door_state`, `events`), y resumen
 * `live/summary` para la vista remota.
 *
 * Eventos que entiende (contrato con T5; lo desconocido se ignora sin error):
 *  - type 'access' (o 'passage') con decision 'grant' → movimiento. Presencia: se aplican los
 *    `payload.stateEffects` que calculó el motor en el controlador:
 *      presence {[cardholderId | 'pass:<id>']: {areaId, ts}} → tabla presence (área exterior o null
 *        = salió del sitio → se borra la fila);
 *      pass {id, status:'ingreso_registrado'|'egreso_registrado', usesDelta?} → meta `hub_pass_state`
 *        (el egreso hacia el exterior cierra el pase y borra su presencia).
 *    Sin stateEffects (eventos viejos) se deriva de `door.sides[side].zoneTo`. Puertas con `sides`
 *    en forma array no tienen áreas → sin presencia.
 *  - type 'door_state' con `payload.state` (o `state`) → door_state. SEGURA restaura held_open/door_forced.
 *  - alarmas: type en ALARM_TYPES o `payload.alarm === true` → alarms (id `${type}:${doorId|deviceId}`).
 *  - type 'alarm_clear' con `payload.alarmType` → alarma 'cleared'.
 *
 * Subida a la nube: como mucho 1 vez cada 60 s y solo si el resumen cambió (hash persistido).
 */

const crypto = require('crypto');
const { readMeta, writeMeta } = require('../lib/db/migrations');
const { canonicalJson } = require('../lib/db/chunkStore');

const ALARM_TYPES = new Set([
  'door_forced', 'held_open', 'lock_fault', 'duress', 'device_offline', 'tamper',
  'apertura_forzada_estanco', 'hub_offline', 'config_stale'
]);
const RESTORED_BY_SECURE = new Set(['door_forced', 'held_open']);
const MOVEMENTS = 50;
const PEOPLE_PER_AREA = 200;

const e2id = (id) => (id === undefined ? null : id);

function isAlarmEvent(e) {
  return ALARM_TYPES.has(e.type) || Boolean(e.payload && e.payload.alarm === true);
}

class LiveState {
  /**
   * @param {{ edge:{db, snapshot}, client?, controllers?, minIntervalMs?:number, log?:object, now?:()=>number }} opts
   */
  constructor({ edge, client = null, controllers = null, minIntervalMs = 60 * 1000, log = console, now = () => Date.now() }) {
    this.edge = edge;
    this.db = edge.db;
    this.client = client;
    this.controllers = controllers;
    this.minIntervalMs = minIntervalMs;
    this.log = log;
    this.now = now;
    this.timer = null;
    this.posting = null;
    this.stats = { posts: 0, skippedUnchanged: 0, skippedThrottle: 0 };
  }

  /** Aplica los eventos recién ingresados (solo los nuevos). Devuelve true si alguno es alarma. */
  applyEvents(events) {
    let alarm = false;
    this.db.tx(() => {
      for (const e of events) {
        if (isAlarmEvent(e)) {
          alarm = true;
          this.raiseAlarm(e);
        }
        if ((e.type === 'access' || e.type === 'passage') && e.decision === 'grant') {
          const fx = e.payload && e.payload.stateEffects;
          if (fx && (fx.presence || fx.pass)) this.applyStateEffects(e, fx);
          else this.updatePresence(e);
        }
        else if (e.type === 'door_state') this.updateDoorState(e);
        else if (e.type === 'alarm_clear') this.clearAlarm(e);
      }
    });
    return alarm;
  }

  raiseAlarm(e) {
    const id = `${e.type}:${e.doorId || e.deviceId}`;
    const ts = Number(e.ts) || this.now();
    const row = this.db.get('SELECT state FROM alarms WHERE id = ?', id);
    if (!row || row.state === 'cleared') {
      this.db.run(
        `INSERT INTO alarms(id, type, door_id, state, first_ts, last_ts, count) VALUES (?, ?, ?, 'active', ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET state = 'active', first_ts = excluded.first_ts, last_ts = excluded.last_ts,
           count = 1, ack_by = NULL, ack_note = NULL`,
        id, e.type, e.doorId ?? null, ts, ts
      );
    } else {
      this.db.run("UPDATE alarms SET state = 'active', last_ts = MAX(last_ts, ?), count = count + 1 WHERE id = ?", ts, id);
    }
  }

  clearAlarm(e) {
    const type = e.payload && e.payload.alarmType;
    if (!type) return;
    this.db.run("UPDATE alarms SET state = 'cleared', last_ts = ? WHERE id = ?", Number(e.ts) || this.now(), `${type}:${e.doorId || e.deviceId}`);
  }

  updateDoorState(e) {
    const state = (e.payload && e.payload.state) || e.state;
    if (!state || !e.doorId) return;
    const ts = Number(e.ts) || this.now();
    const cur = this.db.get('SELECT since FROM door_state WHERE door_id = ?', e.doorId);
    if (cur && Number(cur.since) > ts) return; // evento viejo fuera de orden
    this.db.run(
      `INSERT INTO door_state(door_id, state, since, dps, bond) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(door_id) DO UPDATE SET state = excluded.state, since = excluded.since, dps = excluded.dps, bond = excluded.bond`,
      e.doorId, String(state), ts, e.payload?.dps ?? null, e.payload?.bond ?? null
    );
    if (state === 'SEGURA') {
      for (const type of RESTORED_BY_SECURE) {
        this.db.run("UPDATE alarms SET state = 'restored' WHERE id = ? AND state = 'active'", `${type}:${e.doorId}`);
      }
    }
  }

  /** ¿El área es "fuera del sitio"? (`exterior:true` en el chunk doors, o el id 'exterior'). */
  isExterior(areaId) {
    if (!areaId) return true;
    if (areaId === 'exterior') return true;
    const s = this.edge.snapshot;
    const area = typeof s.area === 'function' ? s.area(areaId) : null;
    return Boolean(area && area.exterior === true);
  }

  /** Presencia de una clave (cardholderId o 'pass:<id>'); ignora eventos viejos fuera de orden. */
  setPresence(key, areaId, ts, eventId) {
    const cur = this.db.get('SELECT ts FROM presence WHERE cardholder_id = ?', key);
    if (cur && Number(cur.ts) > ts) return;
    if (this.isExterior(areaId)) {
      this.db.run('DELETE FROM presence WHERE cardholder_id = ?', key);
      return;
    }
    this.db.run(
      `INSERT INTO presence(cardholder_id, area_id, ts, event_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(cardholder_id) DO UPDATE SET area_id = excluded.area_id, ts = excluded.ts, event_id = excluded.event_id`,
      key, areaId, ts, e2id(eventId)
    );
  }

  passState() {
    try { return JSON.parse(readMeta(this.db, 'hub_pass_state') || '{}') || {}; } catch (_) { return {}; }
  }

  /** Efectos del motor calculados en el controlador (presencia por zoneTo y estado de pases). */
  applyStateEffects(e, fx) {
    const ts = Number(e.ts) || this.now();
    for (const [key, val] of Object.entries(fx.presence || {})) {
      if (!key || !val) continue;
      this.setPresence(key, val.areaId || null, Number(val.ts) || ts, e.id);
    }
    const p = fx.pass;
    if (p && p.id) {
      const all = this.passState();
      const prev = all[p.id] || { uses: 0 };
      if (!(prev.ts && prev.ts > ts)) {
        all[p.id] = {
          status: p.status || prev.status || null,
          uses: (Number(prev.uses) || 0) + (Number(p.usesDelta) || 0),
          ts,
          eventId: e.id
        };
        writeMeta(this.db, 'hub_pass_state', JSON.stringify(all));
      }
      if (p.status === 'egreso_registrado') this.db.run('DELETE FROM presence WHERE cardholder_id = ?', `pass:${p.id}`);
    }
  }

  /** Respaldo sin stateEffects: área destino del lado cruzado. */
  updatePresence(e) {
    if (!e.cardholderId || !e.doorId) return;
    const door = this.edge.snapshot.door(e.doorId);
    const sides = door && door.sides;
    if (!sides || Array.isArray(sides)) return;
    const side = sides[e.side];
    if (!side || !('zoneTo' in side)) return;
    this.setPresence(e.cardholderId, side.zoneTo || null, Number(e.ts) || this.now(), e.id);
  }

  personName(id) {
    try {
      if (id && String(id).startsWith('pass:')) {
        const p = this.edge.snapshot.pass(String(id).slice(5));
        return (p && p.name) || null;
      }
      const ch = id ? this.edge.snapshot.cardholder(id) : null;
      return (ch && ch.name) || null;
    } catch (_) {
      return null;
    }
  }

  /** Resumen sin marca de tiempo (para comparar). */
  buildSummary() {
    const ctlSummary = this.controllers ? this.controllers.summary() : {};
    const doorRows = this.db.all('SELECT id, json FROM doors ORDER BY id');
    const states = new Map(this.db.all('SELECT door_id, state, since FROM door_state').map((r) => [r.door_id, r]));
    const doors = doorRows.map((r) => {
      const d = JSON.parse(r.json);
      const st = states.get(r.id);
      const ctl = d.controllerId ? ctlSummary[d.controllerId] : null;
      return {
        id: r.id,
        name: d.name || r.id,
        state: ctl && ctl.online === false ? 'SIN_CONEXION' : (st ? st.state : 'DESCONOCIDO'),
        since: st ? st.since : null
      };
    });
    const alarms = this.db.all(
      "SELECT id, type, door_id, state, first_ts, last_ts, count FROM alarms WHERE state IN ('active','restored') AND ack_by IS NULL ORDER BY last_ts DESC LIMIT 100"
    ).map((a) => ({ id: a.id, type: a.type, doorId: a.door_id, state: a.state, firstTs: a.first_ts, lastTs: a.last_ts, count: a.count }));
    const movements = this.db.all(
      `SELECT id, ts, door_id, side, cardholder_id FROM events
       WHERE type IN ('access','passage') AND decision = 'grant' ORDER BY ts DESC, id DESC LIMIT ${MOVEMENTS}`
    ).map((m) => ({ id: m.id, ts: m.ts, doorId: m.door_id, side: m.side, cardholderId: m.cardholder_id, name: this.personName(m.cardholder_id) }));
    const presence = {};
    for (const p of this.db.all('SELECT cardholder_id, area_id, ts FROM presence ORDER BY area_id, ts DESC')) {
      const area = presence[p.area_id] || (presence[p.area_id] = { count: 0, people: [] });
      area.count += 1;
      if (area.people.length < PEOPLE_PER_AREA) area.people.push({ id: p.cardholder_id, name: this.personName(p.cardholder_id), since: p.ts });
    }
    return { configVersion: this.edge.chunks ? this.edge.chunks.configVersion() : null, doors, alarms, movements, presence };
  }

  summaryHash(summary) {
    return crypto.createHash('sha256').update(canonicalJson(summary)).digest('hex');
  }

  /**
   * Sube el resumen si cambió y pasó el intervalo mínimo. Nunca lanza.
   * @returns {Promise<'posted'|'unchanged'|'throttled'|'error'|'no_client'>}
   */
  maybePost() {
    if (this.posting) return this.posting;
    this.posting = this.maybePostInner().finally(() => { this.posting = null; });
    return this.posting;
  }

  async maybePostInner() {
    if (!this.client) return 'no_client';
    const lastAt = Number(readMeta(this.db, 'hub_live_posted_at') || 0);
    if (this.now() - lastAt < this.minIntervalMs) {
      this.stats.skippedThrottle += 1;
      return 'throttled';
    }
    const summary = this.buildSummary();
    const hash = this.summaryHash(summary);
    if (hash === readMeta(this.db, 'hub_live_hash')) {
      this.stats.skippedUnchanged += 1;
      return 'unchanged';
    }
    try {
      await this.client.postLive({ ...summary, generatedAt: this.now() });
    } catch (err) {
      this.log.warn(`[hub] live/summary: ${err.message}`);
      return 'error';
    }
    writeMeta(this.db, 'hub_live_hash', hash);
    writeMeta(this.db, 'hub_live_posted_at', this.now());
    this.stats.posts += 1;
    return 'posted';
  }

  start(intervalMs = this.minIntervalMs) {
    this.timer = setInterval(() => { this.maybePost(); }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { LiveState, ALARM_TYPES, isAlarmEvent };
