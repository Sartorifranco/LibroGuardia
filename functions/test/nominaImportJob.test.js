const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const nominaImportPath = require.resolve('../nominaImport');

const installJobMock = (initial) => {
  const state = { ...initial };
  const writes = [];
  const ref = {
    async get() {
      return { exists: true, data: () => ({ ...state }) };
    },
    async set(payload) {
      writes.push(payload);
      Object.assign(state, payload);
    }
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection(name) {
          assert.equal(name, 'nominaImports');
          return { doc: () => ref };
        }
      },
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
        delete: () => 'DELETE_FIELD'
      }
    }
  };
  delete require.cache[nominaImportPath];

  return {
    api: require('../nominaImport'),
    state,
    writes
  };
};

describe('nominaImport job: regresiones de timeout Hosting', () => {
  let originalFirestore;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
  });

  afterEach(() => {
    delete require.cache[nominaImportPath];
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
  });

  it('mantiene defaults de 5 filas/2 workers y topes 10/3', () => {
    // Esta protección evita volver accidentalmente a lotes de 20/40 filas.
    const { normalizeImportStepOptions } = require('../nominaImport');
    assert.deepEqual(normalizeImportStepOptions(), { batchSize: 5, concurrency: 2 });
    assert.deepEqual(
      normalizeImportStepOptions({ batchSize: 40, concurrency: 20 }),
      { batchSize: 10, concurrency: 3 }
    );
    assert.deepEqual(
      normalizeImportStepOptions({ batchSize: 0, concurrency: 0 }),
      { batchSize: 5, concurrency: 2 }
    );
  });

  it('separa finalización/reemplazo en otra llamada corta', async () => {
    const mock = installJobMock({
      status: 'processing',
      cursor: 2,
      rowCount: 2,
      rows: [{ Legajo: 1 }, { Legajo: 2 }],
      replace: false,
      stats: { imported: 2, created: 2, updated: 0, skipped: 0, errors: [] }
    });

    const transition = await mock.api.processNominaImportStep('job-1');
    assert.equal(transition.done, false);
    assert.equal(transition.status, 'finalizing');
    assert.equal(mock.state.status, 'finalizing');

    const finalized = await mock.api.processNominaImportStep('job-1');
    assert.equal(finalized.done, true);
    assert.equal(finalized.status, 'done');
    assert.equal(finalized.imported, 2);
    assert.equal(mock.state.rows, 'DELETE_FIELD');
  });

  it('reintentar un job terminado es idempotente y no vuelve a escribir', async () => {
    const mock = installJobMock({
      status: 'done',
      cursor: 3,
      rowCount: 3,
      stats: { imported: 3, created: 1, updated: 2, skipped: 0, errors: [] }
    });

    const result = await mock.api.processNominaImportStep('job-done');
    assert.equal(result.done, true);
    assert.equal(result.imported, 3);
    assert.equal(mock.writes.length, 0);
  });
});
