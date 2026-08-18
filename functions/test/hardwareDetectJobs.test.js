const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const jobsPath = require.resolve('../lib/hardwareDetectJobs');
const estacionesPath = require.resolve('../lib/estaciones');

const installMock = () => {
  const jobs = new Map();
  const estaciones = new Map();
  let autoId = 0;

  const makeDocRef = (collectionName, id) => ({
    id,
    async get() {
      const store = collectionName === 'hardware_detect_jobs' ? jobs : estaciones;
      const data = store.get(id);
      return {
        exists: Boolean(data),
        id,
        ref: makeDocRef(collectionName, id),
        data: () => (data ? { ...data } : undefined)
      };
    },
    async set(payload, opts = {}) {
      const store = collectionName === 'hardware_detect_jobs' ? jobs : estaciones;
      const prev = store.get(id) || {};
      const next = opts.merge ? { ...prev, ...payload } : { ...payload };
      // Strip FieldValue sentinels for test store
      Object.keys(next).forEach((k) => {
        if (next[k] && typeof next[k] === 'object' && next[k]._sentinel) delete next[k];
      });
      store.set(id, next);
    },
    async delete() {
      const store = collectionName === 'hardware_detect_jobs' ? jobs : estaciones;
      store.delete(id);
    }
  });

  const makeQuery = (collectionName, filters = []) => ({
    where(field, op, value) {
      return makeQuery(collectionName, [...filters, { field, op, value }]);
    },
    limit(n) {
      return makeQuery(collectionName, [...filters, { limit: n }]);
    },
    async get() {
      const store = collectionName === 'hardware_detect_jobs' ? jobs : estaciones;
      let rows = [...store.entries()].map(([id, data]) => ({ id, ...data }));
      const limitFilter = filters.find((f) => f.limit != null);
      const active = filters.filter((f) => f.limit == null);
      rows = rows.filter((row) => active.every((f) => {
        if (f.op === '==') return row[f.field] === f.value;
        if (f.op === '<=') {
          const left = row[f.field];
          const right = f.value;
          const lm = left?.toMillis?.() ?? left;
          const rm = right?.toMillis?.() ?? right;
          return lm <= rm;
        }
        return true;
      }));
      if (limitFilter) rows = rows.slice(0, limitFilter.limit);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((row) => {
          const { id, ...data } = row;
          return {
            id,
            ref: makeDocRef(collectionName, id),
            data: () => ({ ...data })
          };
        })
      };
    }
  });

  const mockDb = {
    collection(name) {
      return {
        doc(id) {
          const docId = id || `job-${++autoId}`;
          return makeDocRef(name, docId);
        },
        where(field, op, value) {
          return makeQuery(name, [{ field, op, value }]);
        },
        async get() {
          return makeQuery(name, []).get();
        }
      };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return ref.get();
        },
        set(ref, payload, opts) {
          return ref.set(payload, opts);
        }
      });
    },
    batch() {
      const ops = [];
      return {
        delete(ref) { ops.push(() => ref.delete()); },
        async commit() {
          for (const op of ops) await op();
        }
      };
    }
  };

  const Timestamp = {
    now: () => ({ toMillis: () => Date.now(), _ts: true }),
    fromMillis: (ms) => ({ toMillis: () => ms, _ms: ms, _ts: true })
  };
  const FieldValue = {
    serverTimestamp: () => ({ _sentinel: 'serverTimestamp' })
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: { db: mockDb, FieldValue, Timestamp, admin: {} }
  };

  // Stub estaciones helpers used by jobs module
  require.cache[estacionesPath] = {
    id: estacionesPath,
    filename: estacionesPath,
    loaded: true,
    exports: {
      getEstacionById: async (id) => {
        const data = estaciones.get(id);
        if (!data) {
          const err = new Error('Estación no encontrada');
          err.status = 404;
          throw err;
        }
        return { id, ...data };
      },
      resolveEstacionForAgentUser: async (username) => {
        const row = [...estaciones.entries()].find(([, e]) =>
          String(e.usuarioSistemaId || '').toLowerCase() === String(username || '').toLowerCase());
        if (!row) {
          const err = new Error('Estación no encontrada para usuario');
          err.status = 404;
          throw err;
        }
        return { id: row[0], ...row[1] };
      }
    }
  };

  delete require.cache[jobsPath];
  const api = require('../lib/hardwareDetectJobs');
  return { api, jobs, estaciones };
};

describe('hardwareDetectJobs', () => {
  let bag;

  beforeEach(() => {
    bag = installMock();
    bag.estaciones.set('est-1', {
      nombre: 'Planta',
      activa: true,
      usuarioSistemaId: 'estacion.planta',
      ultimaConexion: new Date()
    });
  });

  afterEach(() => {
    delete require.cache[jobsPath];
    delete require.cache[estacionesPath];
    delete require.cache[firestorePath];
  });

  it('colección esperada es hardware_detect_jobs (deny en firestore.rules)', () => {
    assert.equal(bag.api.COLLECTION, 'hardware_detect_jobs');
  });

  it('create → claim redacta password en doc y lo entrega solo en response', async () => {
    const created = await bag.api.createHardwareDetectJob({
      estacionId: 'est-1',
      host: '192.168.0.55',
      username: 'admin',
      password: 'secret-device'
    });
    assert.ok(created.jobId);
    const stored = bag.jobs.get(created.jobId);
    assert.equal(stored.password, 'secret-device');
    assert.equal(stored.status, 'pending');

    const claimed = await bag.api.claimHardwareDetectJobs('estacion.planta');
    assert.equal(claimed.jobs.length, 1);
    assert.equal(claimed.jobs[0].password, 'secret-device');
    assert.equal(bag.jobs.get(created.jobId).password, null);
    assert.equal(bag.jobs.get(created.jobId).status, 'running');

    const view = await bag.api.getHardwareDetectJob(created.jobId);
    assert.equal(view.password, undefined);
    assert.equal(view.status, 'running');
  });

  it('estación offline → 409', async () => {
    bag.estaciones.set('est-1', {
      nombre: 'Planta',
      activa: true,
      usuarioSistemaId: 'estacion.planta',
      ultimaConexion: new Date(Date.now() - 60 * 60 * 1000)
    });
    await assert.rejects(
      () => bag.api.createHardwareDetectJob({
        estacionId: 'est-1',
        host: '10.0.0.1',
        password: 'x'
      }),
      (err) => err.status === 409 && err.code === 'station_offline'
    );
  });

  it('report + cleanup por expireAt', async () => {
    const created = await bag.api.createHardwareDetectJob({
      estacionId: 'est-1',
      host: '192.168.0.10',
      password: 'pw'
    });
    await bag.api.claimHardwareDetectJobs('estacion.planta');
    const reported = await bag.api.reportHardwareDetectResult('estacion.planta', {
      jobId: created.jobId,
      status: 'completed',
      candidates: [{ brandId: 'hikvision', confidence: 'high' }],
      probes: [{ vendor: 'hikvision', ok: true }]
    });
    assert.equal(reported.status, 'completed');
    assert.equal(bag.jobs.get(created.jobId).password, null);

    // Forzar vencido y cleanup
    bag.jobs.get(created.jobId).expireAt = { toMillis: () => Date.now() - 1000 };
    const cleaned = await bag.api.cleanupExpiredHardwareDetectJobs({ limit: 50 });
    assert.ok(cleaned.deleted >= 1);
    assert.equal(bag.jobs.has(created.jobId), false);
  });
});
