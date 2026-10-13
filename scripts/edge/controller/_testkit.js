'use strict';

/** Utilidades de los tests del controlador (no es un test). */

/** Reloj manual: timers que solo avanzan con advance(ms). */
function createFakeClock(start = Date.UTC(2026, 9, 8, 13, 0, 0)) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, Number(ms) || 0), fn, id: seq });
      return seq;
    },
    clearTimeout: (h) => {
      timers.delete(h);
    },
    /** Avanza el reloj disparando en orden los timers vencidos (incluye los que agenden). */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const t of timers.values()) {
          if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => timers.size
  };
  return clock;
}

const flush = () => new Promise((r) => setImmediate(r));

module.exports = { createFakeClock, flush };
