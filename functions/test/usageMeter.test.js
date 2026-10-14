const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  categoryForPath,
  withUsageCategory,
  wrapFirestore,
  flushUsage,
  getUsageSnapshot,
  resetUsageForTests,
  runWithUsageMeter,
  pacificDateKey,
  isUsageMeterEnabled
} = require('../lib/usage/meter');
const { estimateDayUsd, budgetStatus } = require('../lib/usage/cost');
const { FIRESTORE_PRICING_USD, PRICING_SOURCE, PRICING_VERIFIED_ON } = require('../lib/usage/pricing');
const { buildUsageReport } = require('../lib/usage/report');
const { evaluateUsageBudget, resetBudgetCheckMemoryForTests } = require('../lib/usage/budget');
const { getRealUsage } = require('../lib/usage/monitoring');
const { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } = require('../permissions');

const memoryDb = (initial = {}) => {
  const docs = new Map(Object.entries(initial));
  const docRef = (path) => ({
    id: path.split('/').pop(),
    path,
    async get() {
      const data = docs.get(path);
      return { id: path.split('/').pop(), exists: data !== undefined, data: () => data, size: data ? 1 : 0 };
    },
    async set(data, opts = {}) {
      const prev = docs.get(path) || {};
      docs.set(path, opts.merge ? { ...prev, ...data } : data);
    },
    async update(data) {
      docs.set(path, { ...(docs.get(path) || {}), ...data });
    },
    async delete() { docs.delete(path); },
    collection(sub) { return collection(`${path}/${sub}`); }
  });
  const collection = (name) => ({
    doc: (id) => docRef(`${name}/${id || 'auto'}`),
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    async get() {
      const list = [...docs.keys()]
        .filter((key) => key.startsWith(`${name}/`) && key.split('/').length === name.split('/').length + 1)
        .map((key) => ({ id: key.split('/').pop(), data: () => docs.get(key) }));
      return { empty: list.length === 0, size: list.length, docs: list };
    },
    async add() {
      return docRef(`${name}/new`);
    }
  });
  return {
    docs,
    collection,
    doc: (path) => docRef(path),
    async getAll(...refs) {
      return Promise.all(refs.map((ref) => ref.get()));
    },
    batch() {
      const ops = [];
      const api = {
        set(ref, data) { ops.push(() => ref.set(data)); return api; },
        update(ref, data) { ops.push(() => ref.update(data)); return api; },
        delete(ref) { ops.push(() => ref.delete()); return api; },
        create(ref, data) { ops.push(() => ref.set(data)); return api; },
        async commit() { for (const op of ops) await op(); }
      };
      return api;
    }
  };
};

const FieldValue = {
  increment: (n) => ({ __inc: n }),
  serverTimestamp: () => 'ts'
};

describe('medidor de consumo', () => {
  beforeEach(() => {
    resetUsageForTests();
    resetBudgetCheckMemoryForTests();
  });

  it('en tests el medidor queda apagado si nadie lo enciende', () => {
    assert.equal(isUsageMeterEnabled(), false);
  });

  it('clasifica las rutas por origen', () => {
    assert.equal(categoryForPath('/api/edge/v1/events'), 'edge');
    assert.equal(categoryForPath('/api/entries'), 'guardia');
    assert.equal(categoryForPath('/api/guard/alarms'), 'guardia');
    assert.equal(categoryForPath('/api/admin/users'), 'admin');
    assert.equal(categoryForPath('/api/admin/fleet-gps'), 'gps');
    assert.equal(categoryForPath('/api/admin/biostar/status'), 'biostar');
    assert.equal(categoryForPath('/api/auth/login'), 'auth');
    assert.equal(categoryForPath('/api/search'), 'otros');
  });

  it('cuenta lecturas, escrituras y el volcado como una escritura', async () => {
    const raw = memoryDb();
    const db = wrapFirestore(raw);
    const now = new Date('2026-10-09T18:00:00Z');
    await runWithUsageMeter(async () => {
      await withUsageCategory('gps', async () => {
        await db.collection('settings').doc('fleetGps').get();
        await db.collection('mobiles').where('name', '==', 'x').get();
        await db.collection('entries').add({ type: 'flota' });
      });
      const batch = db.batch();
      batch.set(db.collection('settings').doc('a'), { ok: 1 });
      batch.delete(db.collection('settings').doc('b'));
      await batch.commit();
      const flushed = await flushUsage({ force: true, db: raw, FieldValue, now });
      assert.equal(flushed.flushed, true);
      assert.equal(flushed.date, '20261009');
    });

    const saved = raw.docs.get('usage/20261009');
    assert.equal(saved.reads.gps.__inc, 2);
    assert.equal(saved.writes.gps.__inc, 1);
    assert.equal(saved.deletes.otros.__inc, 1);
    assert.ok(saved.writes.otros.__inc >= 1);
    assert.equal(getUsageSnapshot().reads.gps, undefined);

    const again = await runWithUsageMeter(() => flushUsage({ force: true, db: raw, FieldValue, now }));
    assert.equal(again.flushed, false);
  });

  it('collection.doc() sin argumento no le pasa undefined a Firestore (id automático)', () => {
    const calls = [];
    const raw = { collection: () => ({ doc: (...args) => { calls.push(args.length); return { id: 'auto' }; } }) };
    wrapFirestore(raw).collection('empresas').doc();
    assert.deepEqual(calls, [0]);
  });

  it('descuenta la cuota gratis del día', () => {
    assert.equal(PRICING_VERIFIED_ON, '2026-10-08');
    assert.equal(PRICING_SOURCE, 'https://cloud.google.com/firestore/pricing');
    assert.equal(estimateDayUsd({ reads: 50000, writes: 20000, deletes: 20000 }), 0);
    assert.equal(estimateDayUsd({ reads: 150000, writes: 0, deletes: 0 }), 0.045);
    assert.equal(budgetStatus(6, 5), 'over');
    assert.equal(budgetStatus(3, 5), 'ok');
    assert.equal(pacificDateKey(new Date('2026-10-09T18:00:00Z')), '20261009');
  });

  it('arma el reporte y manda el aviso de tope una sola vez por día', async () => {
    const now = new Date('2026-10-09T18:00:00Z');
    const db = memoryDb({
      'usage/20261009': { writes: { gps: 20000000 }, reads: { gps: 100 }, deletes: {}, invocations: {} }
    });
    const mails = [];
    const first = await evaluateUsageBudget({
      db,
      FieldValue,
      now,
      notify: async (type, payload) => {
        mails.push({ type, payload });
        return { sent: true };
      }
    });
    assert.equal(first.over, true);
    assert.equal(first.mailed, true);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].type, 'usage_budget');

    const second = await evaluateUsageBudget({
      db,
      FieldValue,
      now,
      notify: async () => { mails.push({ type: 'otra' }); }
    });
    assert.equal(second.skipped, true);
    assert.equal(mails.length, 1);

    const report = await buildUsageReport({
      db,
      FieldValue,
      days: 30,
      now,
      includeMonitoring: false
    });
    assert.equal(report.alarm, true);
    assert.ok(report.month.projectedUsd > report.budgetUsd);
    assert.equal(report.topCategories[0].id, 'gps');
    assert.match(report.topCategories[0].note, /5 minutos/);
  });

  it('si Monitoring no tiene permiso, lo dice y no inventa números', async () => {
    const db = memoryDb();
    let calls = 0;
    const result = await getRealUsage({
      db,
      FieldValue,
      now: new Date('2026-10-09T18:00:00Z'),
      projectId: 'mss-guard',
      getToken: async () => 'token',
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: { message: 'Permission denied' } })
        };
      }
    });
    assert.equal(result.available, false);
    assert.match(result.reason, /Monitoring/);
    const cached = await getRealUsage({
      db,
      FieldValue,
      now: new Date('2026-10-09T18:05:00Z'),
      projectId: 'mss-guard',
      getToken: async () => 'token',
      fetchImpl: async () => { calls += 1; return { ok: false, status: 403, json: async () => ({}) }; }
    });
    assert.equal(cached.available, false);
    assert.equal(calls, 1);
  });

  it('el supervisor y el admin pueden ver el consumo', () => {
    assert.ok(PERMISSION_KEYS.includes('consumo.ver'));
    assert.ok(DEFAULT_ROLE_PERMISSIONS.supervisor.includes('consumo.ver'));
    assert.ok(DEFAULT_ROLE_PERMISSIONS.admin.includes('consumo.ver'));
  });
});
