const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const nominaImportPath = require.resolve('../nominaImport');
const authorizationsPath = require.resolve('../authorizations');

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
  let originalAuthorizations;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
    originalAuthorizations = require.cache[authorizationsPath];
  });

  afterEach(() => {
    delete require.cache[nominaImportPath];
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
    if (originalAuthorizations) require.cache[authorizationsPath] = originalAuthorizations;
    else delete require.cache[authorizationsPath];
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

  it('autorización usa nomina-perm-{personId} sin query previa', async () => {
    const writes = [];
    require.cache[firestorePath] = {
      id: firestorePath,
      filename: firestorePath,
      loaded: true,
      exports: {
        db: {
          collection(name) {
            assert.equal(name, 'authorizations');
            return {
              // No se implementa where(): si vuelve la query costosa, el test falla.
              doc(id) {
                return {
                  id,
                  async set(payload, options) {
                    writes.push({ id, payload, options });
                  }
                };
              }
            };
          }
        },
        FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }
      }
    };
    require.cache[authorizationsPath] = {
      id: authorizationsPath,
      filename: authorizationsPath,
      loaded: true,
      exports: {
        buildAuthorizationRecord: (record) => ({ ...record }),
        buildNameTokens: (name) => String(name || '').toLowerCase()
      }
    };
    delete require.cache[nominaImportPath];
    const { syncNominaAuthorization } = require('../nominaImport');

    const id = await syncNominaAuthorization(
      { id: 'person-26' },
      {
        createPermanent: true,
        name: 'SOSA Franco',
        idNumberNormalized: '23796878',
        legajoNormalized: '26',
        centroCosto: 'Sistemas',
        area: 'Sistemas',
        role: 'Técnico',
        puesto: 'Técnico',
        authorizationPolicy: 'permanent_shift',
        shiftSchedule: {
          daysOfWeek: ['Lu'],
          timeWindow: { from: '08:00', to: '17:00' }
        }
      }
    );

    assert.equal(id, 'nomina-perm-person-26');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 'nomina-perm-person-26');
    assert.equal(writes[0].payload.source, 'nomina');
    assert.equal(writes[0].payload.active, true);
    assert.deepEqual(writes[0].options, { merge: true });
  });
});
