'use strict';

/**
 * Journal de eventos append-only del edge.
 *
 * - Controlador: `append()` asigna un `seq` monotónico propio, persistido en meta('journal_seq')
 *   en la misma transacción que el INSERT (sobrevive reinicios y cortes). Id = `${deviceId}:${seq}`.
 *   `pendingBatch()` / `ack(uptoSeq)` contra el hub.
 * - Hub: `ingest(events)` recibe lotes de los controladores con INSERT OR IGNORE (idempotente por id)
 *   y asigna `hub_seq` solo a los nuevos. `pendingBatch()` / `ack(uptoHubSeq)` contra la nube
 *   (`ackHubSeq`). El hub también puede `append()` eventos propios (reciben hub_seq).
 * - `purge()` borra solo eventos ya confirmados (acked=1) más viejos que la retención (90 días).
 */

const { readMeta, writeMeta } = require('./migrations');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

const COLUMNS = 'id, seq, ts, clock_q, device_id, door_id, side, type, cred_type, cred_hash, cardholder_id, decision, reason, payload_json, acked, hub_seq';

function rowToEvent(r) {
  return {
    id: r.id,
    seq: r.seq,
    ts: r.ts,
    clockQ: r.clock_q,
    deviceId: r.device_id,
    doorId: r.door_id,
    side: r.side,
    type: r.type,
    credType: r.cred_type,
    credHash: r.cred_hash,
    cardholderId: r.cardholder_id,
    decision: r.decision,
    reason: r.reason,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    acked: r.acked === 1,
    hubSeq: r.hub_seq
  };
}

function nz(v) {
  return v === undefined ? null : v;
}

class Journal {
  /**
   * @param {import('./driver').Db} db base ya migrada
   * @param {{ deviceId:string, role?:'hub'|'controller', now?:()=>number }} opts
   */
  constructor(db, { deviceId, role = 'controller', now = () => Date.now() } = {}) {
    if (!deviceId) throw new Error('Journal: falta deviceId');
    this.db = db;
    this.deviceId = String(deviceId);
    this.role = role;
    this.now = now;
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO events(${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    this.reconcileCounters();
  }

  /** Defensa extra: el contador nunca queda por debajo de lo que ya hay en la tabla. */
  reconcileCounters() {
    this.db.tx(() => {
      const maxSeq = this.db.get('SELECT MAX(seq) AS m FROM events WHERE device_id = ?', this.deviceId).m || 0;
      if (maxSeq > this.lastSeq()) writeMeta(this.db, 'journal_seq', maxSeq);
      if (this.role === 'hub') {
        const maxHub = this.db.get('SELECT MAX(hub_seq) AS m FROM events').m || 0;
        if (maxHub > this.lastHubSeq()) writeMeta(this.db, 'journal_hub_seq', maxHub);
      }
    });
  }

  lastSeq() {
    return Number(readMeta(this.db, 'journal_seq') || 0);
  }

  lastHubSeq() {
    return Number(readMeta(this.db, 'journal_hub_seq') || 0);
  }

  insertRow(e, seq, hubSeq) {
    return this.insertStmt.run(
      e.id, seq, Number(e.ts), nz(e.clockQ), String(e.deviceId), nz(e.doorId), nz(e.side), nz(e.type),
      nz(e.credType), nz(e.credHash), nz(e.cardholderId), nz(e.decision), nz(e.reason),
      e.payload === undefined || e.payload === null ? null : JSON.stringify(e.payload), hubSeq
    );
  }

  /**
   * Agrega un evento propio. `ts` por defecto = now(). Devuelve el evento guardado.
   */
  append(evt = {}) {
    return this.db.tx(() => {
      const seq = this.lastSeq() + 1;
      writeMeta(this.db, 'journal_seq', seq);
      let hubSeq = null;
      if (this.role === 'hub') {
        hubSeq = this.lastHubSeq() + 1;
        writeMeta(this.db, 'journal_hub_seq', hubSeq);
      }
      const e = {
        ...evt,
        id: `${this.deviceId}:${seq}`,
        deviceId: this.deviceId,
        ts: evt.ts === undefined || evt.ts === null ? this.now() : Number(evt.ts)
      };
      this.insertRow(e, seq, hubSeq);
      return { ...e, seq, acked: false, hubSeq, payload: e.payload ?? null };
    });
  }

  /**
   * Hub: ingesta idempotente de un lote de un controlador (o reintento del mismo lote).
   * @returns {{ inserted:number, duplicates:number, ackSeqByDevice:Object<string,number> }}
   *   ackSeqByDevice = mayor seq recibido por equipo (todos quedaron guardados, nuevos o repetidos).
   */
  ingest(events) {
    if (this.role !== 'hub') throw new Error('Journal.ingest: solo en el hub');
    return this.db.tx(() => {
      let inserted = 0;
      let duplicates = 0;
      const ackSeqByDevice = {};
      let hubSeq = this.lastHubSeq();
      for (const raw of events || []) {
        const deviceId = raw && raw.deviceId;
        const seq = Number(raw && raw.seq);
        if (!deviceId || !Number.isInteger(seq) || seq < 1) {
          const err = new Error(`Journal.ingest: evento inválido ${JSON.stringify(raw)}`);
          err.code = 'EVENT_INVALID';
          throw err;
        }
        const id = `${deviceId}:${seq}`;
        if (raw.id && raw.id !== id) {
          const err = new Error(`Journal.ingest: id "${raw.id}" no coincide con ${id}`);
          err.code = 'EVENT_INVALID';
          throw err;
        }
        const res = this.insertRow({ ...raw, id, ts: raw.ts ?? this.now() }, seq, hubSeq + 1);
        if (res.changes === 1) {
          hubSeq += 1;
          inserted += 1;
        } else {
          duplicates += 1;
        }
        ackSeqByDevice[deviceId] = Math.max(ackSeqByDevice[deviceId] || 0, seq);
      }
      if (hubSeq !== this.lastHubSeq()) writeMeta(this.db, 'journal_hub_seq', hubSeq);
      return { inserted, duplicates, ackSeqByDevice };
    });
  }

  /** Próximo lote sin confirmar: controlador por seq propio, hub por hub_seq. */
  pendingBatch(limit = 200) {
    const n = Math.max(1, Number(limit) | 0);
    if (this.role === 'hub') {
      return this.db.all(`SELECT ${COLUMNS} FROM events WHERE acked = 0 ORDER BY hub_seq LIMIT ?`, n).map(rowToEvent);
    }
    return this.db
      .all(`SELECT ${COLUMNS} FROM events WHERE acked = 0 AND device_id = ? ORDER BY seq LIMIT ?`, this.deviceId, n)
      .map(rowToEvent);
  }

  /** Confirma hasta `upto` inclusive (seq en el controlador, hub_seq en el hub). Devuelve filas marcadas. */
  ack(upto) {
    const n = Number(upto);
    if (!Number.isFinite(n)) return 0;
    return this.db.tx(() => {
      const res = this.role === 'hub'
        ? this.db.run('UPDATE events SET acked = 1 WHERE acked = 0 AND hub_seq <= ?', n)
        : this.db.run('UPDATE events SET acked = 1 WHERE acked = 0 AND device_id = ? AND seq <= ?', this.deviceId, n);
      const prev = Number(readMeta(this.db, 'journal_acked_upto') || 0);
      if (n > prev) writeMeta(this.db, 'journal_acked_upto', n);
      return res.changes;
    });
  }

  /** Borra eventos confirmados con ts anterior a la retención. Nunca toca pendientes. */
  purge({ retentionDays = DEFAULT_RETENTION_DAYS, now = this.now() } = {}) {
    const cutoff = Number(now) - Number(retentionDays) * DAY_MS;
    return this.db.run('DELETE FROM events WHERE acked = 1 AND ts < ?', cutoff).changes;
  }

  get(id) {
    const r = this.db.get(`SELECT ${COLUMNS} FROM events WHERE id = ?`, id);
    return r ? rowToEvent(r) : null;
  }

  stats() {
    const r = this.db.get('SELECT COUNT(*) AS total, SUM(CASE WHEN acked = 0 THEN 1 ELSE 0 END) AS pending FROM events');
    return {
      total: r.total || 0,
      pending: r.pending || 0,
      lastSeq: this.lastSeq(),
      lastHubSeq: this.lastHubSeq(),
      ackedUpto: Number(readMeta(this.db, 'journal_acked_upto') || 0)
    };
  }
}

module.exports = { Journal, rowToEvent, DEFAULT_RETENTION_DAYS };
