const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const normalizePath = require.resolve('../lib/normalize');
const biostarImportPath = require.resolve('../lib/biostarImport');

const installMock = () => {
  const people = new Map();
  const entries = new Map();
  let autoId = 0;

  const storeFor = (name) => {
    if (name === 'people') return people;
    if (name === 'entries') return entries;
    return new Map();
  };

  const makeDocRef = (collectionName, id) => ({
    id,
    async get() {
      const data = storeFor(collectionName).get(id);
      return {
        exists: Boolean(data),
        id,
        data: () => (data ? { ...data } : undefined)
      };
    },
    async set(payload, opts = {}) {
      const store = storeFor(collectionName);
      const prev = store.get(id) || {};
      store.set(id, opts.merge ? { ...prev, ...payload } : { ...payload });
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
      const store = storeFor(collectionName);
      let rows = [...store.entries()].map(([id, data]) => ({ id, ...data }));
      const limitFilter = filters.find((f) => f.limit != null);
      const active = filters.filter((f) => f.limit == null);
      rows = rows.filter((row) => active.every((f) => {
        if (f.op === '==') return row[f.field] === f.value;
        return true;
      }));
      if (limitFilter) rows = rows.slice(0, limitFilter.limit);
      return {
        empty: rows.length === 0,
        docs: rows.map((row) => {
          const { id, ...data } = row;
          return { id, data: () => ({ ...data }) };
        })
      };
    }
  });

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection(name) {
          return {
            doc(id) {
              if (!id) {
                autoId += 1;
                id = `auto_${autoId}`;
              }
              return makeDocRef(name, id);
            },
            where(field, op, value) {
              return makeQuery(name, [{ field, op, value }]);
            }
          };
        }
      },
      FieldValue: {
        serverTimestamp: () => ({ __sv: true })
      },
      Timestamp: {
        fromDate: (d) => ({ toDate: () => d, __ts: d.toISOString() })
      }
    }
  };

  delete require.cache[normalizePath];
  delete require.cache[biostarImportPath];
  return { people, entries };
};

describe('biostarImport', () => {
  let people;
  let entries;
  let importBiostarUsers;
  let importBiostarEvents;
  let eventDocId;

  beforeEach(() => {
    ({ people, entries } = installMock());
    ({ importBiostarUsers, importBiostarEvents, eventDocId } = require('../lib/biostarImport'));
  });

  afterEach(() => {
    delete require.cache[firestorePath];
    delete require.cache[biostarImportPath];
  });

  it('crea persona con biometricExternalId = user_id BioStar', async () => {
    const result = await importBiostarUsers(
      [{ user_id: '42', name: 'Juan Pérez', disabled: 'false' }],
      { defaultDoorId: 'puerta-p1' }
    );
    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
    const row = [...people.values()][0];
    assert.equal(row.biometricExternalId, '42');
    assert.equal(row.biometricBrand, 'suprema');
    assert.equal(row.name, 'Juan Pérez');
    assert.deepEqual(row.allowedDoorIds, ['puerta-p1']);
    assert.equal(row.active, true);
  });

  it('actualiza persona existente por biometricExternalId', async () => {
    people.set('p1', {
      biometricExternalId: '42',
      name: 'Viejo',
      allowedDoorIds: ['otra']
    });
    const result = await importBiostarUsers(
      [{ user_id: '42', name: 'Nuevo', disabled: 'true' }],
      { defaultDoorId: 'puerta-p1' }
    );
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(people.get('p1').name, 'Nuevo');
    assert.equal(people.get('p1').active, false);
    assert.deepEqual(people.get('p1').allowedDoorIds, ['otra', 'puerta-p1']);
  });

  it('importa evento idempotente con entrySource biostar', async () => {
    people.set('p1', {
      biometricExternalId: '7',
      name: 'Ana',
      idNumber: '30111222'
    });
    const ev = {
      id: 'evt-1',
      datetime: '2026-07-24T12:00:00.000Z',
      user_id: { user_id: '7', name: 'Ana' },
      door_id: { id: '1' },
      event_type_id: { code: '4867' }
    };
    const first = await importBiostarEvents([ev], {
      defaultDoorId: 'puerta-p1',
      doorMap: { '1': 'puerta-p1' },
      successEventCodes: ['4867']
    });
    assert.equal(first.accepted, 1);
    assert.equal(entries.get(eventDocId('evt-1')).entrySource, 'biostar');
    assert.equal(entries.get(eventDocId('evt-1')).authorized, true);
    assert.equal(entries.get(eventDocId('evt-1')).personId, 'p1');

    const second = await importBiostarEvents([ev], {
      defaultDoorId: 'puerta-p1',
      doorMap: { '1': 'puerta-p1' }
    });
    assert.equal(second.accepted, 0);
    assert.equal(second.skipped, 1);
  });

  it('marca denegado si el código no está en successEventCodes', async () => {
    const ev = {
      id: 'evt-deny',
      datetime: '2026-07-24T13:00:00.000Z',
      user_id: '9',
      door_id: '1',
      event_type_id: { code: '9999' }
    };
    const result = await importBiostarEvents([ev], {
      defaultDoorId: 'puerta-p1',
      successEventCodes: ['4867']
    });
    assert.equal(result.accepted, 1);
    assert.equal(entries.get(eventDocId('evt-deny')).authorized, false);
  });
});
