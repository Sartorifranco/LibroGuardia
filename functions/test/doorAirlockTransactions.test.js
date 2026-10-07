/**
 * Estanco + cooldown en Firestore (transacción), sin timers en memoria:
 * dos instancias distintas ven el mismo estado.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const doorControllerPath = require.resolve('../doorController');

/** Firestore compartido entre "instancias" (cada una recarga el módulo). */
const createSharedStore = () => {
  const collections = new Map();
  const col = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const ref = (name, id) => ({
    id,
    async get() {
      const data = col(name).get(id);
      return { exists: Boolean(data), id, data: () => (data ? { ...data } : undefined) };
    },
    async set(payload, opts = {}) {
      const prev = col(name).get(id) || {};
      col(name).set(id, opts.merge ? { ...prev, ...payload } : { ...payload });
    }
  });
  const db = {
    collection: (name) => ({ doc: (id) => ref(name, id), async add() { return { id: 'x' }; } }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: (r) => r.get(),
        set(r, data, opts) { writes.push(() => r.set(data, opts)); return tx; }
      };
      const out = await fn(tx);
      for (const w of writes) await w();
      return out;
    }
  };
  return { db, col };
};

const loadInstance = (store) => {
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: { db: store.db, FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }, Timestamp: {} }
  };
  delete require.cache[doorControllerPath];
  return require('../doorController');
};

const group = { id: 'estanco-1', outerCloseDelayMs: 1000, interDoorDelayMs: 500, transitTimeoutMs: 60000 };
const outer = { id: 'ext', airlockRole: 'outer', airlockGroupId: 'estanco-1' };
const inner = { id: 'int', airlockRole: 'inner', airlockGroupId: 'estanco-1' };

describe('deriveAirlockPhase (sin timers)', () => {
  it('la fase avanza sola con el tiempo desde la apertura exterior', () => {
    const { deriveAirlockPhase } = loadInstance(createSharedStore());
    const data = { phase: 'outer_open', outerOpenedAtMs: 10_000 };
    assert.equal(deriveAirlockPhase(data, group, 10_500), 'outer_open');
    assert.equal(deriveAirlockPhase(data, group, 11_200), 'outer_closed_pending');
    assert.equal(deriveAirlockPhase(data, group, 12_000), 'inner_allowed');
    assert.equal(deriveAirlockPhase(data, group, 10_000 + 1500 + 60_000), 'idle');
    assert.equal(deriveAirlockPhase({ phase: 'inner_open', innerOpenedAtMs: 5000 }, group, 9000), 'idle');
  });
});

describe('reserveDoorOpen (transacción compartida entre instancias)', () => {
  it('dos instancias: la segunda apertura exterior se bloquea (423)', async () => {
    const store = createSharedStore();
    const a = loadInstance(store);
    await a.reserveDoorOpen({ door: outer, group, airlockApplies: true, nowMs: 100_000 });
    const b = loadInstance(store);
    await assert.rejects(
      () => b.reserveDoorOpen({ door: { ...outer, id: 'ext-2' }, group, airlockApplies: true, nowMs: 100_200 }),
      (err) => err.status === 423
    );
  });

  it('interior se habilita por tiempo aunque la instancia que abrió ya no exista', async () => {
    const store = createSharedStore();
    await loadInstance(store).reserveDoorOpen({ door: outer, group, airlockApplies: true, nowMs: 100_000 });
    const other = loadInstance(store);
    await assert.rejects(
      () => other.reserveDoorOpen({ door: inner, group, airlockApplies: true, nowMs: 100_500 }),
      (err) => err.status === 423
    );
    const res = await other.reserveDoorOpen({ door: inner, group, airlockApplies: true, nowMs: 102_000 });
    assert.equal(res.airlockCheck.allowed, true);
    assert.equal(store.col('doorAirlockStates').get('estanco-1').phase, 'inner_open');
  });

  it('cooldown por puerta compartido entre instancias (429)', async () => {
    const store = createSharedStore();
    const door = { id: 'p1' };
    await loadInstance(store).reserveDoorOpen({ door, group: null, airlockApplies: false, nowMs: 50_000 });
    const other = loadInstance(store);
    await assert.rejects(
      () => other.reserveDoorOpen({ door, group: null, airlockApplies: false, nowMs: 51_000 }),
      (err) => err.status === 429
    );
    const ok = await other.reserveDoorOpen({ door, group: null, airlockApplies: false, nowMs: 50_000 + other.MANUAL_COOLDOWN_MS });
    assert.ok(ok);
  });
});
