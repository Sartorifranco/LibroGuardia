'use strict';

/**
 * Subida de eventos hub → nube.
 *
 * - Lotes ≤200 por `hub_seq` (journal.pendingBatch) → POST /api/edge/v1/events
 *   { hubId, events, hubSeqFrom, hubSeqTo } → { ackHubSeq } → journal.ack(ackHubSeq).
 * - Cada 2 min, o ya mismo si entra una alarma (`kick()`).
 * - Reintento idempotente: el lote en vuelo se reintenta con el MISMO rango [from, to]
 *   (la nube arma el id determinístico `{YYYYMMDD}_{hubId}_{hubSeqFrom}`).
 * - Backoff exponencial ante fallas (30 s → 10 min). Sin internet solo acumula en SQLite:
 *   no hay tope de cola (retención solo borra confirmados).
 */

const { readMeta, writeMeta } = require('../lib/db/migrations');

const BATCH_MAX = 200;

function toWire(e) {
  return {
    id: e.id,
    seq: e.seq,
    hubSeq: e.hubSeq,
    ts: e.ts,
    clockQ: e.clockQ,
    deviceId: e.deviceId,
    doorId: e.doorId,
    side: e.side,
    type: e.type,
    credType: e.credType,
    credHash: e.credHash,
    cardholderId: e.cardholderId,
    decision: e.decision,
    reason: e.reason,
    payload: e.payload
  };
}

class EventUploader {
  /**
   * @param {{ edge:{db, journal}, client, hubId:string, intervalMs?:number, batchMax?:number,
   *           backoffMinMs?:number, backoffMaxMs?:number, log?:object, now?:()=>number }} opts
   */
  constructor({ edge, client, hubId, intervalMs = 2 * 60 * 1000, batchMax = BATCH_MAX,
    backoffMinMs = 30 * 1000, backoffMaxMs = 10 * 60 * 1000, log = console, now = () => Date.now() }) {
    this.edge = edge;
    this.client = client;
    this.hubId = hubId;
    this.intervalMs = intervalMs;
    this.batchMax = Math.min(BATCH_MAX, Math.max(1, batchMax));
    this.backoffMinMs = backoffMinMs;
    this.backoffMaxMs = backoffMaxMs;
    this.log = log;
    this.now = now;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.running = null;
    this.timer = null;
    this.kickTimer = null;
    this.lastUploadAt = null;
    this.lastError = null;
  }

  /** Lote en vuelo persistido: sobrevive reinicios para reintentar el mismo rango. */
  inflight() {
    const raw = readMeta(this.edge.db, 'hub_upload_inflight');
    return raw ? JSON.parse(raw) : null;
  }

  setInflight(v) {
    writeMeta(this.edge.db, 'hub_upload_inflight', v ? JSON.stringify(v) : null);
  }

  nextBatch() {
    const fly = this.inflight();
    let events = this.edge.journal.pendingBatch(this.batchMax);
    if (fly) events = events.filter((e) => e.hubSeq >= fly.from && e.hubSeq <= fly.to);
    if (!events.length) {
      if (fly) this.setInflight(null);
      return null;
    }
    const from = events[0].hubSeq;
    const to = events[events.length - 1].hubSeq;
    if (!fly) this.setInflight({ from, to });
    return { events, from, to };
  }

  /**
   * Sube todo lo pendiente (varios lotes). Respeta el backoff salvo `force`.
   * @returns {Promise<{uploaded:number, batches:number, pending:number, error?:string}>}
   */
  flush({ force = false } = {}) {
    if (this.running) return this.running;
    this.running = this.flushInner({ force }).finally(() => { this.running = null; });
    return this.running;
  }

  async flushInner({ force }) {
    let uploaded = 0;
    let batches = 0;
    if (!force && this.now() < this.nextAttemptAt) {
      return { uploaded, batches, pending: this.edge.journal.stats().pending, skipped: 'backoff' };
    }
    for (;;) {
      const batch = this.nextBatch();
      if (!batch) break;
      let res;
      try {
        res = await this.client.postEvents({
          hubId: this.hubId, events: batch.events.map(toWire), hubSeqFrom: batch.from, hubSeqTo: batch.to
        });
      } catch (err) {
        this.failures += 1;
        const delay = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** Math.min(this.failures - 1, 10));
        this.nextAttemptAt = this.now() + delay;
        this.lastError = err.message;
        if (err.retryable === false) this.log.error(`[hub] subida de eventos rechazada: ${err.message}`);
        return { uploaded, batches, pending: this.edge.journal.stats().pending, error: err.code || err.message };
      }
      const ack = Number(res && res.ackHubSeq);
      if (!Number.isFinite(ack) || ack < batch.from) {
        // La nube no confirmó nada de este lote: tratar como falla reintentable.
        this.failures += 1;
        this.nextAttemptAt = this.now() + this.backoffMinMs;
        this.lastError = `ackHubSeq inválido (${res && res.ackHubSeq})`;
        return { uploaded, batches, pending: this.edge.journal.stats().pending, error: 'BAD_ACK' };
      }
      this.edge.journal.ack(Math.min(ack, batch.to));
      this.setInflight(null);
      uploaded += batch.events.filter((e) => e.hubSeq <= ack).length;
      batches += 1;
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.lastUploadAt = this.now();
      this.lastError = null;
    }
    return { uploaded, batches, pending: this.edge.journal.stats().pending };
  }

  /** Alarma nueva: subir ya (ignora el backoff una vez, con un pequeño debounce). */
  kick() {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.flush({ force: true }).catch((err) => this.log.warn(`[hub] subida: ${err.message}`));
    }, 250);
    if (this.kickTimer.unref) this.kickTimer.unref();
  }

  start() {
    // Revisa cada ≤30 s: sube si pasó la cadencia (2 min) o, con fallas, apenas vence el backoff.
    this.lastTickAt = 0;
    const gated = () => {
      if (this.failures === 0 && this.now() - this.lastTickAt < this.intervalMs) return;
      this.lastTickAt = this.now();
      this.flush().catch((err) => this.log.warn(`[hub] subida: ${err.message}`));
    };
    this.timer = setInterval(gated, Math.min(this.intervalMs, 30 * 1000));
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
  }

  status() {
    return {
      pending: this.edge.journal.stats().pending,
      lastUploadAt: this.lastUploadAt,
      failures: this.failures,
      nextAttemptAt: this.nextAttemptAt || null,
      lastError: this.lastError
    };
  }
}

module.exports = { EventUploader, toWire, BATCH_MAX };
