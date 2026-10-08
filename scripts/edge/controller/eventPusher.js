'use strict';

/**
 * Empuje de eventos controlador → hub con ack por seq y backoff exponencial (docs/ETAPA2-DISENO.md §4).
 *
 *  - Lotes de hasta 200 eventos pendientes (journal.pendingBatch) → POST /edge/events.
 *  - El hub responde { ackSeq } (o ackSeqByDevice[deviceId]); se confirma hasta ahí (journal.ack).
 *    Un ack parcial deja el resto para el próximo envío. Reintentos idempotentes: el id es deviceId:seq.
 *  - Falla → espera 1 s, 2 s, 4 s … hasta 60 s. Con lote vacío se manda igual cada heartbeatMs (heartbeat + estado).
 *  - kick() fuerza un envío ya (evento nuevo), salvo que se esté en backoff.
 */

const { nullLogger } = require('../drivers/logger');

class EventPusher {
  /**
   * @param {{journal:object, hub:{pushEvents:Function}, deviceId:string, clock?:object, logger?:object,
   *          batchSize?:number, heartbeatMs?:number, minBackoffMs?:number, maxBackoffMs?:number,
   *          extra?:()=>object}} opts
   */
  constructor({
    journal, hub, deviceId, clock = null, logger = nullLogger, batchSize = 200,
    heartbeatMs = 5000, minBackoffMs = 1000, maxBackoffMs = 60000, extra = () => ({})
  }) {
    this.journal = journal;
    this.hub = hub;
    this.deviceId = deviceId;
    this.clock = clock || { now: () => Date.now(), setTimeout, clearTimeout };
    this.logger = logger;
    this.batchSize = batchSize;
    this.heartbeatMs = heartbeatMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.extra = extra;
    this.failures = 0;
    this.timer = null;
    this.inFlight = null;
    this.stopped = true;
    this.status = { lastOkAt: null, lastError: null, lastAckSeq: null, sent: 0, failures: 0, nextAttemptAt: null };
  }

  backoffMs() {
    return Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** Math.max(0, this.failures - 1));
  }

  /** Un envío. → {ok, sent, ackSeq} | {ok:false, error} */
  async pushOnce() {
    const batch = this.journal.pendingBatch(this.batchSize);
    const events = batch.map(({ acked, hubSeq, ...e }) => e);
    try {
      const res = await this.hub.pushEvents({ deviceId: this.deviceId, events, ...this.extra() });
      const ackSeq = Number(res && (res.ackSeq ?? (res.ackSeqByDevice && res.ackSeqByDevice[this.deviceId])));
      if (Number.isFinite(ackSeq) && ackSeq > 0) this.journal.ack(ackSeq);
      this.failures = 0;
      this.status.lastOkAt = this.clock.now();
      this.status.lastError = null;
      this.status.lastAckSeq = Number.isFinite(ackSeq) ? ackSeq : this.status.lastAckSeq;
      this.status.sent += events.length;
      const more = events.length > 0 && Number.isFinite(ackSeq) && ackSeq >= events[events.length - 1].seq
        && events.length === this.batchSize;
      return { ok: true, sent: events.length, ackSeq: Number.isFinite(ackSeq) ? ackSeq : null, more };
    } catch (err) {
      this.failures += 1;
      this.status.failures += 1;
      this.status.lastError = err.message;
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.logger.warn('No se pudieron enviar eventos al hub (se reintenta)', { error: err.message, pending: events.length, failures: this.failures });
      }
      return { ok: false, error: err.message };
    }
  }

  schedule(ms) {
    if (this.stopped) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.status.nextAttemptAt = this.clock.now() + ms;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.run();
    }, ms);
  }

  async run() {
    if (this.stopped || this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const r = await this.pushOnce();
      this.inFlight = null;
      if (!r.ok) this.schedule(this.backoffMs());
      else if (r.more) this.schedule(0);
      else this.schedule(this.heartbeatMs);
      return r;
    })();
    return this.inFlight;
  }

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  /** Hay un evento nuevo: enviar pronto (respetando el backoff si el hub está caído). */
  kick() {
    if (this.stopped || this.failures > 0 || this.inFlight) return;
    this.schedule(50);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { EventPusher };
