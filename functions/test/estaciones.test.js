const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const lectoresPath = require.resolve('../lib/lectores');
const estacionesPath = require.resolve('../lib/estaciones');
const doorsConfigPath = require.resolve('../lib/doorsConfig');
const rolesPath = require.resolve('../roles');

const installMock = () => {
  const users = new Map();
  const roles = new Map();
  const lectores = new Map();
  const estaciones = new Map();
  let autoId = 0;

  const storeFor = (name) => {
    if (name === 'users') return users;
    if (name === 'roles') return roles;
    if (name === 'estaciones') return estaciones;
    return lectores;
  };

  const makeDocRef = (collectionName, id) => ({
    id,
    async get() {
      const store = storeFor(collectionName);
      const data = store.get(id);
      return {
        exists: Boolean(data),
        id,
        ref: makeDocRef(collectionName, id),
        data: () => (data ? { ...data } : undefined)
      };
    },
    async set(payload, opts = {}) {
      const store = storeFor(collectionName);
      const prev = store.get(id) || {};
      store.set(id, opts.merge ? { ...prev, ...payload } : { ...payload });
    },
    async update(payload) {
      const store = storeFor(collectionName);
      const prev = store.get(id) || {};
      store.set(id, { ...prev, ...payload });
    },
    async delete() {
      storeFor(collectionName).delete(id);
    }
  });

  const makeQuery = (collectionName, filters = []) => ({
    where(field, op, value) {
      return makeQuery(collectionName, [...filters, { field, op, value }]);
    },
    limit(n) {
      return makeQuery(collectionName, [...filters, { limit: n }]);
    },
    orderBy() {
      return makeQuery(collectionName, filters);
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
          return {
            id,
            ref: makeDocRef(collectionName, id),
            data: () => ({ ...data })
          };
        }),
        size: rows.length
      };
    }
  });

  const mockDb = {
    collection(name) {
      return {
        doc(id) {
          const docId = id || `auto-${++autoId}`;
          return makeDocRef(name, docId);
        },
        where(field, op, value) {
          return makeQuery(name, [{ field, op, value }]);
        },
        orderBy() {
          return makeQuery(name, []);
        },
        limit(n) {
          return makeQuery(name, [{ limit: n }]);
        },
        async get() {
          return makeQuery(name, []).get();
        }
      };
    }
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: mockDb,
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }
    }
  };

  require.cache[doorsConfigPath] = {
    id: doorsConfigPath,
    filename: doorsConfigPath,
    loaded: true,
    exports: {
      getDoorsConfig: async () => ({
        doors: [{
          id: 'puerta-p1',
          name: 'Puerta 1',
          readers: [
            { id: 'INGRESO_P1', direction: 'ingreso' },
            { id: 'EGRESO_P1', direction: 'egreso' }
          ],
          readerIds: ['INGRESO_P1', 'EGRESO_P1']
        }, {
          id: 'puerta-p2',
          name: 'Puerta 2',
          readers: [{ id: 'INGRESO_P2', direction: 'ingreso' }],
          readerIds: ['INGRESO_P2']
        }]
      }),
      findDoorById: (config, doorId) => (config.doors || []).find((d) => d.id === doorId) || null
    }
  };

  delete require.cache[rolesPath];
  delete require.cache[lectoresPath];
  delete require.cache[estacionesPath];

  // lectores primero (estaciones lo importa)
  const lectoresApi = require('../lib/lectores');
  const estacionesApi = require('../lib/estaciones');

  return {
    users,
    roles,
    lectores,
    estaciones,
    lectoresApi,
    estacionesApi
  };
};

describe('estaciones — modelo y config unificada', () => {
  let originalFirestore;
  let originalDoors;
  let originalRoles;
  let bag;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
    originalDoors = require.cache[doorsConfigPath];
    originalRoles = require.cache[rolesPath];
    bag = installMock();
  });

  afterEach(() => {
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
    if (originalDoors) require.cache[doorsConfigPath] = originalDoors;
    else delete require.cache[doorsConfigPath];
    if (originalRoles) require.cache[rolesPath] = originalRoles;
    else delete require.cache[rolesPath];
    delete require.cache[lectoresPath];
    delete require.cache[estacionesPath];
  });

  it('crea estación con secreto auto-generado y defaults', async () => {
    const estacion = await bag.estacionesApi.createEstacion({
      nombre: 'Mini PC entrada',
      direccionRedLocal: '192.168.1.50'
    });
    assert.equal(estacion.nombre, 'Mini PC entrada');
    assert.equal(estacion.direccionRedLocal, '192.168.1.50');
    assert.equal(estacion.puertoServidorLocal, 8787);
    assert.ok(estacion.secretoLocal.length >= 16);
    assert.equal(estacion.activa, true);
  });

  it('asocia lectores y arma config readers[] + localServer', async () => {
    const estacion = await bag.estacionesApi.createEstacion({
      nombre: 'Estación A',
      direccionRedLocal: '192.168.1.50',
      puertoServidorLocal: 9000,
      secretoLocal: 'sec-estacion-a'
    });

    const a = await bag.lectoresApi.createLector({
      nombre: 'Lector A',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso',
      offlineCache: true,
      localFirstMode: true
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });

    const b = await bag.lectoresApi.createLector({
      nombre: 'Lector B',
      doorId: 'puerta-p2',
      readerId: 'INGRESO_P2',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });

    await bag.estacionesApi.setLectoresDeEstacion(estacion.id, [a.lector.id, b.lector.id]);

    const linked = await bag.lectoresApi.getLectorById(a.lector.id);
    assert.equal(linked.estacionId, estacion.id);

    const config = await bag.estacionesApi.buildStationConfigForDownload(estacion.id, {
      apiBaseUrl: 'https://bacarguard.web.app/api'
    });

    assert.equal(config.apiBaseUrl, 'https://bacarguard.web.app/api');
    assert.equal(config.localServerPort, 9000);
    assert.equal(config.localServerSecret, 'sec-estacion-a');
    assert.equal(config.readers.length, 2);
    assert.equal(config.readers[0].password, '');
    assert.ok(config.readers.some((r) => r.doorId === 'puerta-p1' && r.localFirstMode === true));
    assert.ok(config.readers.some((r) => r.doorId === 'puerta-p2'));
    assert.equal(config._meta.direccionRedLocal, '192.168.1.50');
  });

  it('lector sin estacionId sigue siendo válido (retrocompat)', async () => {
    const created = await bag.lectoresApi.createLector({
      nombre: 'Solo',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });
    assert.equal(created.lector.estacionId, '');
    assert.equal(created.config.doorId, 'puerta-p1');
    assert.ok(!created.config.readers);
  });

  it('rechaza estacionId inexistente al actualizar lector', async () => {
    const created = await bag.lectoresApi.createLector({
      nombre: 'Solo',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });

    await assert.rejects(
      () => bag.lectoresApi.updateLector(created.lector.id, { estacionId: 'no-existe' }),
      (err) => err.code === 'unknown_estacion'
    );
  });

  it('al borrar estación desasocia lectores', async () => {
    const estacion = await bag.estacionesApi.createEstacion({
      nombre: 'Temp',
      secretoLocal: 'x'
    });
    const created = await bag.lectoresApi.createLector({
      nombre: 'L1',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso',
      estacionId: estacion.id
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });

    assert.equal(created.lector.estacionId, estacion.id);
    await bag.estacionesApi.deleteEstacion(estacion.id);
    const after = await bag.lectoresApi.getLectorById(created.lector.id);
    assert.equal(after.estacionId, '');
  });
});
