'use strict';

/**
 * Comandos remotos nube → hub → controlador (hito 1: poll; fase 2: listener sobre `commands`).
 *
 * Cuándo se consulta la nube (solo si hay internet, `client.online !== false`):
 *  - Si `GET /api/edge/v1/head` trae `pendingCommands` (pista), solo se piden comandos cuando es > 0.
 *  - Si no la trae, poll de `GET /api/edge/v1/commands?status=pending` cada 10 s
 *    (costo: ≥1 lectura Firestore por consulta aunque venga vacía → ~8.640 lecturas/día por sitio).
 *  - Si el endpoint no existe (404/501) se deja de consultar por 5 min.
 *
 * Cada comando `{id, doorId, action:'open', requestedBy, reason, force, expiresAt}` se procesa una
 * sola vez (tabla `commands`), se rutea al controlador dueño de la puerta y el resultado real se
 * reporta con `POST /api/edge/v1/commands/:id/result` (reintentado si falla el reporte).
 * Además queda un evento `remote_command` en el journal (auditoría en la nube vía lotes).
 */

const { toMs } = require('../lib/db/chunkStore');

const FINAL = new Set(['done', 'failed', 'expired', 'rejected']);

class CommandRouter {
  /**
   * @param {{ edge:{db, journal, snapshot}, client, controllers, hubId:string, intervalMs?:number,
   *           log?:object, now?:()=>number }} opts
   */
  constructor({ edge, client, controllers, hubId, intervalMs = 10 * 1000, log = console, now = () => Date.now() }) {
    this.edge = edge;
    this.db = edge.db;
    this.client = client;
    this.controllers = controllers;
    this.hubId = hubId;
    this.intervalMs = intervalMs;
    this.log = log;
    this.now = now;
    this.hint = undefined; // undefined = la nube no da pista
    this.disabledUntil = 0;
    this.timer = null;
    this.running = null;
    this.stats = { polls: 0, processed: 0 };
    this.recoverRunning();
  }

  /** Un comando quedó 'running' si el hub se cayó en medio: no se reintenta (puede haber abierto). */
  recoverRunning() {
    this.db.run(
      "UPDATE commands SET status = 'failed', result_json = ? WHERE source = 'cloud' AND status = 'running'",
      JSON.stringify({ result: { ok: false, code: 'HUB_RESTARTED' }, reported: false })
    );
  }

  /** Pista que viene con el head (ver PollHeadSource). */
  setHint(pendingCommands) {
    this.hint = pendingCommands === undefined ? this.hint : pendingCommands;
  }

  shouldPoll() {
    if (this.client.online === false) return false;
    if (this.now() < this.disabledUntil) return false;
    if (this.hint !== undefined && this.hint <= 0) return false;
    return true;
  }

  poll({ force = false } = {}) {
    if (this.running) return this.running;
    this.running = this.pollInner({ force }).finally(() => { this.running = null; });
    return this.running;
  }

  async pollInner({ force }) {
    await this.retryReports();
    if (!force && !this.shouldPoll()) return { polled: false, processed: 0 };
    let res;
    try {
      res = await this.client.listCommands();
      this.stats.polls += 1;
    } catch (err) {
      if (err.status === 404 || err.status === 501) {
        this.disabledUntil = this.now() + 5 * 60 * 1000;
        this.log.warn('[hub] la nube no expone GET /api/edge/v1/commands: se reintenta en 5 min');
      }
      return { polled: false, processed: 0, error: err.code || err.message };
    }
    const list = Array.isArray(res) ? res : (res && res.commands) || [];
    let processed = 0;
    for (const cmd of list) {
      if (await this.process(cmd)) processed += 1;
    }
    if (this.hint !== undefined) this.hint = 0; // ya se atendieron; la próxima pista la renueva
    return { polled: true, processed };
  }

  row(id) {
    const r = this.db.get('SELECT id, status, result_json FROM commands WHERE id = ?', id);
    if (!r) return null;
    return { id: r.id, status: r.status, ...(r.result_json ? JSON.parse(r.result_json) : {}) };
  }

  save(cmd, status, result, reported) {
    this.db.run(
      `INSERT INTO commands(id, source, door_id, action, status, requested_by, reason, result_json, ts) VALUES (?, 'cloud', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, result_json = excluded.result_json, ts = excluded.ts`,
      cmd.id, cmd.doorId ?? null, cmd.action ?? null, status, cmd.requestedBy ?? null, cmd.reason ?? null,
      JSON.stringify({ result, reported }), this.now()
    );
  }

  /** @returns {Promise<boolean>} true si se ejecutó/decidió ahora (no repetido). */
  async process(cmd) {
    if (!cmd || !cmd.id) return false;
    const prev = this.row(cmd.id);
    if (prev && (FINAL.has(prev.status) || prev.status === 'running')) {
      if (FINAL.has(prev.status) && !prev.reported) await this.report(cmd, prev.status, prev.result);
      return false;
    }
    let status;
    let result;
    const expiresAt = toMs(cmd.expiresAt);
    if (cmd.status && cmd.status !== 'pending') {
      return false;
    } else if (expiresAt && expiresAt < this.now()) {
      status = 'expired';
      result = { ok: false, code: 'COMMAND_EXPIRED' };
    } else if (cmd.action !== 'open') {
      status = 'rejected';
      result = { ok: false, code: 'ACTION_UNSUPPORTED' };
    } else {
      const owner = this.controllers.ownerOf(cmd.doorId, this.edge.snapshot);
      if (!owner) {
        status = 'failed';
        result = { ok: false, code: 'DOOR_NOT_ROUTED' };
      } else {
        this.save(cmd, 'running', null, false);
        try {
          const r = await this.controllers.openDoor(owner.deviceId, cmd.doorId, {
            requestedBy: cmd.requestedBy, reason: cmd.reason, force: cmd.force
          });
          const ok = !(r && r.ok === false);
          status = ok ? 'done' : 'failed';
          result = { ok, controllerId: owner.deviceId, ...(r || {}) };
        } catch (err) {
          status = 'failed';
          result = { ok: false, controllerId: owner.deviceId, code: err.code || 'CONTROLLER_ERROR', message: err.message, ...(err.body || {}) };
        }
      }
    }
    this.save(cmd, status, result, false);
    try {
      this.edge.journal.append({
        doorId: cmd.doorId ?? null, type: 'remote_command', decision: status, reason: result.code || null,
        payload: { commandId: cmd.id, action: cmd.action, requestedBy: cmd.requestedBy ?? null, reason: cmd.reason ?? null, force: Boolean(cmd.force), result }
      });
    } catch (err) {
      this.log.warn(`[hub] journal remote_command: ${err.message}`);
    }
    this.stats.processed += 1;
    await this.report(cmd, status, result);
    return true;
  }

  async report(cmd, status, result) {
    try {
      await this.client.commandResult(cmd.id, { hubId: this.hubId, status, result, ts: this.now() });
      this.save(cmd, status, result, true);
    } catch (err) {
      this.log.warn(`[hub] resultado del comando ${cmd.id}: ${err.message} (se reintenta)`);
    }
  }

  /** Reportes pendientes de comandos ya ejecutados (p. ej. se cortó internet justo después). */
  async retryReports() {
    if (this.client.online === false) return;
    const rows = this.db.all("SELECT id, door_id, action, status, result_json FROM commands WHERE source = 'cloud' AND status IN ('done','failed','expired','rejected')");
    for (const r of rows) {
      const data = r.result_json ? JSON.parse(r.result_json) : {};
      if (data.reported) continue;
      await this.report({ id: r.id, doorId: r.door_id, action: r.action }, r.status, data.result);
    }
  }

  start() {
    this.timer = setInterval(() => { this.poll().catch((err) => this.log.warn(`[hub] comandos: ${err.message}`)); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { CommandRouter };
