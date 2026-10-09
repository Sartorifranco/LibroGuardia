'use strict';

/**
 * Publica transiciones de puerta al journal (`type: 'door_state'`).
 * Ráfagas de menos de `coalesceMs` quedan en un solo evento (el estado final).
 * Tope: `maxPerSec` eventos por puerta en cualquier ventana de 1 s; el último
 * estado igual se emite cuando hay cupo.
 */

const COALESCE_MS = 200;
const MAX_PER_SEC = 5;
const WINDOW_MS = 1000;

class DoorStateReporter {
  /**
   * @param {{ record:(evt:object)=>void, clock:{now:()=>number, setTimeout:Function, clearTimeout:Function},
   *           coalesceMs?:number, maxPerSec?:number }} opts
   */
  constructor({ record, clock, coalesceMs = COALESCE_MS, maxPerSec = MAX_PER_SEC }) {
    this.record = record;
    this.clock = clock;
    this.coalesceMs = coalesceMs;
    this.maxPerSec = maxPerSec;
    this.pending = new Map();
    this.sentAt = new Map();
    this.timer = null;
  }

  note(st) {
    if (!st || !st.doorId || !st.state) return;
    this.pending.set(st.doorId, {
      doorId: st.doorId,
      state: st.state,
      dps: st.dps ?? null,
      bond: st.bond ?? null,
      since: st.since ?? null
    });
    this.arm();
  }

  arm() {
    if (this.timer != null || !this.pending.size) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.flush(false);
    }, this.waitMs());
  }

  waitMs() {
    const now = this.clock.now();
    let limited = false;
    let slot = 0;
    for (const doorId of this.pending.keys()) {
      const times = this.recent(doorId, now);
      if (times.length < this.maxPerSec) continue;
      limited = true;
      const until = times[0] + WINDOW_MS - now;
      if (until > slot) slot = until;
    }
    if (limited && this.pending.size === this.limitedCount(now)) return Math.max(this.coalesceMs, slot);
    return this.coalesceMs;
  }

  limitedCount(now) {
    let n = 0;
    for (const doorId of this.pending.keys()) {
      if (this.recent(doorId, now).length >= this.maxPerSec) n += 1;
    }
    return n;
  }

  recent(doorId, now) {
    const times = (this.sentAt.get(doorId) || []).filter((t) => now - t < WINDOW_MS);
    this.sentAt.set(doorId, times);
    return times;
  }

  flush(force) {
    const now = this.clock.now();
    const deferred = new Map();
    for (const [doorId, snap] of this.pending) {
      const times = this.recent(doorId, now);
      if (!force && times.length >= this.maxPerSec) {
        deferred.set(doorId, snap);
        continue;
      }
      this.record({
        type: 'door_state',
        doorId,
        payload: {
          state: snap.state,
          dps: snap.dps,
          bond: snap.bond,
          since: snap.since
        }
      });
      times.push(now);
      this.sentAt.set(doorId, times);
    }
    this.pending = deferred;
    if (!force && this.pending.size) this.arm();
  }

  /** Emite el último estado pendiente (apagado del controlador). */
  stop() {
    if (this.timer != null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.flush(true);
  }
}

module.exports = { DoorStateReporter, COALESCE_MS, MAX_PER_SEC };
