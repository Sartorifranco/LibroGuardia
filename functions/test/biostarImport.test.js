const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const normalizePath = require.resolve('../lib/normalize');
const biostarImportPath = require.resolve('../lib/biostarImport');
const peoplePath = require.resolve('../people');
const biostarMatchPath = require.resolve('../lib/biostarMatch');
const peopleAlertsPath = require.resolve('../lib/peopleAlerts');

const installMock = () => {
  const people = new Map();
  const entries = new Map();
  const deviceEvents = new Map();
  const ops = { reads: 0, queries: 0, getAll: 0, commits: 0, writes: 0 };
  let autoId = 0;

  const storeFor = (name) => {
    if (name === 'people') return people;
    if (name === 'entries') return entries;
    if (name === 'deviceEvents') return deviceEvents;
    return new Map();
  };

  const makeDocRef = (collectionName, id) => ({
    id,
    collectionName,
    async get() {
      ops.reads += 1;
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
      ops.queries += 1;
      const store = storeFor(collectionName);
      let rows = [...store.entries()].map(([id, data]) => ({ id, ...data }));
      const limitFilter = filters.find((f) => f.limit != null);
      const active = filters.filter((f) => f.limit == null);
      rows = rows.filter((row) => active.every((f) => {
        if (f.op === '==') return row[f.field] === f.value;
        if (f.op === 'in') return f.value.includes(row[f.field]);
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
        async getAll(...refs) {
          ops.getAll += 1;
          return refs.map((ref) => {
            const data = storeFor(ref.collectionName).get(ref.id);
            return { exists: Boolean(data), id: ref.id, data: () => (data ? { ...data } : undefined) };
          });
        },
        batch() {
          const pending = [];
          return {
            set(ref, payload) { pending.push([ref, payload]); },
            async commit() {
              ops.commits += 1;
              pending.forEach(([ref, payload]) => {
                ops.writes += 1;
                storeFor(ref.collectionName).set(ref.id, { ...payload });
              });
            }
          };
        },
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
        serverTimestamp: () => ({ __sv: true }),
        delete: () => ({ __delete: true })
      },
      Timestamp: {
        fromDate: (d) => ({ toDate: () => d, __ts: d.toISOString() })
      }
    }
  };

  [
    normalizePath,
    biostarImportPath,
    peoplePath,
    biostarMatchPath,
    peopleAlertsPath
  ].forEach((p) => { delete require.cache[p]; });
  return { people, entries, deviceEvents, ops };
};

describe('biostarImport', () => {
  let people;
  let entries;
  let deviceEvents;
  let ops;
  let importBiostarUsers;
  let importBiostarEvents;
  let eventDocId;

  beforeEach(() => {
    ({ people, entries, deviceEvents, ops } = installMock());
    ({ importBiostarUsers, importBiostarEvents, eventDocId } = require('../lib/biostarImport'));
  });

  afterEach(() => {
    [
      firestorePath,
      biostarImportPath,
      peoplePath,
      biostarMatchPath,
      peopleAlertsPath
    ].forEach((p) => { delete require.cache[p]; });
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
    assert.equal(row.category, 'sin_clasificar');
  });

  it('vincula por DNI si user_id parece DNI y ya existe persona', async () => {
    people.set('p1', {
      dniNormalized: '38646611',
      name: 'SARTORI Franco',
      allowedDoorIds: ['puerta-p1'],
      source: 'nomina',
      active: true
    });
    // Mock findPersonByDni via firestore query on dniNormalized
    const result = await importBiostarUsers(
      [{ user_id: '38646611', name: 'SARTORI Franco', disabled: 'false' }],
      { defaultDoorId: 'puerta-p2' }
    );
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.linkedByDni, 1);
    assert.equal(people.get('p1').biometricExternalId, '38646611');
    // No agrega puerta nueva si ya tenía puertas
    assert.deepEqual(people.get('p1').allowedDoorIds, ['puerta-p1']);
  });

  it('actualiza persona existente por biometricExternalId sin agregar puertas si ya tiene', async () => {
    people.set('p1', {
      biometricExternalId: '42',
      name: 'Viejo',
      allowedDoorIds: ['otra'],
      source: 'nomina'
    });
    const result = await importBiostarUsers(
      [{ user_id: '42', name: 'Nuevo', disabled: 'true' }],
      { defaultDoorId: 'puerta-p1' }
    );
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(people.get('p1').name, 'Nuevo');
    assert.equal(people.get('p1').active, false);
    assert.deepEqual(people.get('p1').allowedDoorIds, ['otra']);
  });

  it('huérfano BioStar con todas las puertas queda solo en defaultDoorId', async () => {
    people.set('p1', {
      biometricExternalId: '99',
      name: 'Limpieza X',
      allowedDoorIds: ['puerta-p1', 'puerta-p2'],
      source: 'biostar',
      active: true
    });
    const result = await importBiostarUsers(
      [{ user_id: '99', name: 'Limpieza X', disabled: 'false' }],
      { defaultDoorId: 'puerta-p2' }
    );
    assert.equal(result.updated, 1);
    assert.deepEqual(people.get('p1').allowedDoorIds, ['puerta-p2']);
  });

  it('no reactiva ficha mergeada: actualiza el canónico con DNI', async () => {
    people.set('orphan', {
      biometricExternalId: '55',
      name: 'Franco S',
      source: 'biostar',
      active: false,
      mergedIntoId: 'emp'
    });
    people.set('emp', {
      name: 'SARTORI Franco',
      dniNormalized: '38646611',
      idNumber: '38646611',
      biometricExternalId: '55',
      source: 'nomina',
      allowedDoorIds: ['puerta-p2'],
      active: true
    });
    const result = await importBiostarUsers(
      [{ user_id: '55', name: 'Franco S', disabled: 'false' }],
      { defaultDoorId: 'puerta-p2' }
    );
    assert.equal(result.updated, 1);
    assert.equal(people.get('orphan').active, false);
    assert.equal(people.get('emp').biometricExternalId, '55');
    assert.equal(people.get('emp').active, true);
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

  it('marca denegado un fallo de identificación (5124 = huella no reconocida)', async () => {
    const ev = {
      id: 'evt-deny',
      datetime: '2026-07-24T13:00:00.000Z',
      user_id: '9',
      door_id: '1',
      event_type_id: { code: '5124' }
    };
    const result = await importBiostarEvents([ev], {
      defaultDoorId: 'puerta-p1',
      successEventCodes: ['4867']
    });
    assert.equal(result.accepted, 1);
    assert.equal(entries.get(eventDocId('evt-deny')).authorized, false);
  });

  it('identificación por huella (4865) cuenta como autorizada aunque no esté en la lista', async () => {
    const result = await importBiostarEvents([{
      id: 'evt-fp',
      datetime: '2026-07-24T13:00:00.000Z',
      user_id: { user_id: '9' },
      event_type_id: { code: '4865' }
    }], { defaultDoorId: 'puerta-p1', successEventCodes: ['4867'] });
    assert.equal(result.accepted, 1);
    assert.equal(entries.get(eventDocId('evt-fp')).authorized, true);
  });

  it('eventos de equipo (puerta forzada, desconocidos) van a deviceEvents y no a entries', async () => {
    const result = await importBiostarEvents([
      {
        id: 'evt-forced',
        datetime: '2026-07-24T14:00:00.000Z',
        device_id: { id: '544', name: 'Molinete P2' },
        door_id: [{ id: '2', name: 'Puerta 2' }],
        event_type_id: { code: '22016' }
      },
      {
        id: 'evt-unknown',
        datetime: '2026-07-24T14:00:01.000Z',
        event_type_id: { code: '9999' }
      }
    ], { defaultDoorId: 'puerta-p1', doorMap: { '2': 'puerta-p2' } });
    assert.equal(result.accepted, 0);
    assert.equal(result.deviceEvents, 2);
    assert.equal(entries.size, 0);
    const forced = deviceEvents.get(eventDocId('evt-forced'));
    assert.equal(forced.source, 'biostar');
    assert.equal(forced.deviceId, '544');
    assert.equal(forced.doorId, 'puerta-p2');
    assert.equal(forced.code, '22016');
    assert.equal(forced.raw.deviceName, 'Molinete P2');
    // Idempotente: reimportar no duplica.
    const again = await importBiostarEvents([{
      id: 'evt-forced',
      datetime: '2026-07-24T14:00:00.000Z',
      event_type_id: { code: '22016' }
    }], { defaultDoorId: 'puerta-p1' });
    assert.equal(again.deviceEvents, 0);
    assert.equal(again.skipped, 1);
  });

  it('sentido por mapa de equipos y por tna_key; si no se sabe, ingreso marcado como desconocido', async () => {
    await importBiostarEvents([
      { id: 'e-dev', datetime: '2026-07-24T10:00:00.000Z', user_id: '1', device_id: { id: '700' }, event_type_id: { code: '4865' } },
      { id: 'e-tna', datetime: '2026-07-24T10:00:01.000Z', user_id: '1', device_id: { id: '800' }, tna_key: 2, event_type_id: { code: '4865' } },
      { id: 'e-none', datetime: '2026-07-24T10:00:02.000Z', user_id: '1', device_id: { id: '800' }, event_type_id: { code: '4865' } }
    ], {
      defaultDoorId: 'puerta-p1',
      devices: { '700': { doorId: 'puerta-salida', direction: 'egreso' } }
    });
    const dev = entries.get(eventDocId('e-dev'));
    assert.equal(dev.tipoMovimiento, 'egreso');
    assert.equal(dev.doorId, 'puerta-salida');
    assert.equal(dev.direccionDesconocida, false);
    assert.equal(dev.directionSource, 'device');
    const tna = entries.get(eventDocId('e-tna'));
    assert.equal(tna.tipoMovimiento, 'egreso');
    assert.equal(tna.directionSource, 'tna_key');
    assert.equal(tna.doorId, 'puerta-p1');
    const none = entries.get(eventDocId('e-none'));
    assert.equal(none.tipoMovimiento, 'ingreso');
    assert.equal(none.directionInferred, false);
    assert.equal(none.direccionDesconocida, true);
  });

  it('50 eventos se importan con pocas operaciones de Firestore', async () => {
    for (let i = 0; i < 40; i += 1) {
      people.set(`p${i}`, { biometricExternalId: String(i), name: `Persona ${i}`, active: true });
    }
    const events = [];
    for (let i = 0; i < 50; i += 1) {
      events.push({
        id: `bulk-${i}`,
        datetime: new Date(Date.UTC(2026, 7, 15, 3, 0, i)).toISOString(),
        user_id: { user_id: String(i % 40) },
        event_type_id: { code: i % 10 === 0 ? '22016' : '4865' }
      });
    }
    const result = await importBiostarEvents(events, { defaultDoorId: 'puerta-p1' });
    assert.equal(result.accepted, 45);
    assert.equal(result.deviceEvents, 5);
    assert.equal(result.processed, 50);
    assert.equal(result.partial, false);
    assert.equal(result.cursorDatetime, events[49].datetime);
    assert.equal(entries.get(eventDocId('bulk-1')).personId, 'p1');
    // 1 getAll + 2 consultas `in` (≤ 40 ids / 30) + 1 commit; nada de lecturas por evento.
    assert.equal(ops.getAll, 1);
    assert.equal(ops.queries, 2);
    assert.equal(ops.reads, 0);
    assert.equal(ops.commits, 1);
    assert.equal(ops.writes, 50);
  });

  it('corta por presupuesto de tiempo y devuelve el cursor del último lote escrito', async () => {
    const events = [];
    for (let i = 0; i < 120; i += 1) {
      events.push({
        id: `slow-${i}`,
        datetime: new Date(Date.UTC(2026, 7, 15, 4, 0, i)).toISOString(),
        user_id: '1',
        event_type_id: { code: '4865' }
      });
    }
    let fakeNow = 0;
    const result = await importBiostarEvents(events, {
      defaultDoorId: 'puerta-p1',
      chunkSize: 50,
      timeBudgetMs: 1000,
      now: () => {
        fakeNow += 1000;
        return fakeNow;
      }
    });
    assert.equal(result.partial, true);
    assert.equal(result.processed, 50);
    assert.equal(result.cursorDatetime, events[49].datetime);
    assert.equal(result.lastEventId, 'slow-49');
    assert.equal(entries.size, 50);
  });
});
