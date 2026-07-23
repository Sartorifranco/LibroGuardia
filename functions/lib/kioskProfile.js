/**
 * Profiler liviano para processKioskScan (AsyncLocalStorage).
 * No cambia comportamiento: solo marca tiempos si hay un store activo.
 */

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

const nowMs = () => {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
};

const mark = (label) => {
  const ctx = store.getStore();
  if (!ctx) return;
  const at = nowMs();
  ctx.marks.push({
    label,
    stepMs: Math.round((at - ctx.last) * 10) / 10,
    sinceStartMs: Math.round((at - ctx.t0) * 10) / 10
  });
  ctx.last = at;
};

const finish = (extra = {}) => {
  const ctx = store.getStore();
  if (!ctx) return null;
  const totalMs = Math.round((nowMs() - ctx.t0) * 10) / 10;
  const summary = {
    totalMs,
    marks: ctx.marks,
    meta: { ...ctx.meta, ...extra }
  };
  console.log('[kiosk-profile]', JSON.stringify(summary));
  return summary;
};

/**
 * Ejecuta fn dentro del store de profiling (propagado a awaits).
 */
const runWithKioskProfile = async (meta, fn) => {
  const t0 = nowMs();
  return store.run({ t0, last: t0, marks: [], meta: meta || {} }, async () => fn());
};

const isProfiling = () => Boolean(store.getStore());

module.exports = {
  runWithKioskProfile,
  mark,
  finish,
  isProfiling
};
