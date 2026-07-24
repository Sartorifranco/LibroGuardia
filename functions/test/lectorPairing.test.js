const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const firestorePath = require.resolve('../firestore');
const lectoresPath = require.resolve('../lib/lectores');
const pairingPath = require.resolve('../lib/lectorPairing');
const doorsConfigPath = require.resolve('../lib/doorsConfig');
const rolesPath = require.resolve('../roles');

const installMock = () => {
  const users = new Map();
  const roles = new Map();
  const lectores = new Map();
  const estaciones = new Map();
  const pairingCodes = new Map();
  let autoId = 0;

  const storeFor = (name) => {
    if (name === 'users') return users;
    if (name === 'roles') return roles;
    if (name === 'estaciones') return estaciones;
    if (name === 'lectorPairingCodes') return pairingCodes;
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

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
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
      },
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
          readers: [{ id: 'INGRESO_P1', direction: 'ingreso' }],
          readerIds: ['INGRESO_P1']
        }]
      }),
      findDoorById: (config, doorId) => (config.doors || []).find((d) => d.id === doorId) || null
    }
  };

  delete require.cache[rolesPath];
  delete require.cache[lectoresPath];
  delete require.cache[pairingPath];

  const lectoresApi = require('../lib/lectores');
  const pairingApi = require('../lib/lectorPairing');

  return { users, lectores, pairingCodes, lectoresApi, pairingApi };
};

describe('lectorPairing', () => {
  let originals;
  let bag;

  beforeEach(() => {
    originals = {
      firestore: require.cache[firestorePath],
      doors: require.cache[doorsConfigPath],
      roles: require.cache[rolesPath]
    };
    bag = installMock();
  });

  afterEach(() => {
    if (originals.firestore) require.cache[firestorePath] = originals.firestore;
    else delete require.cache[firestorePath];
    if (originals.doors) require.cache[doorsConfigPath] = originals.doors;
    else delete require.cache[doorsConfigPath];
    if (originals.roles) require.cache[rolesPath] = originals.roles;
    else delete require.cache[rolesPath];
    delete require.cache[lectoresPath];
    delete require.cache[pairingPath];
  });

  it('genera código de 6 dígitos con TTL 10 min', async () => {
    const created = await bag.lectoresApi.createLector({
      nombre: 'Ingreso',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });

    const pair = await bag.pairingApi.createPairingCode(created.lector.id);
    assert.match(pair.code, /^\d{6}$/);
    assert.equal(pair.expiresInSeconds, 600);
    assert.equal(pair.lectorId, created.lector.id);
    assert.ok(bag.pairingCodes.has(pair.code));
  });

  it('canje válido regenera password y devuelve config completa', async () => {
    const created = await bag.lectoresApi.createLector({
      nombre: 'Ingreso',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });
    const oldHash = bag.users.get(created.username).password;

    const pair = await bag.pairingApi.createPairingCode(created.lector.id);
    const exchanged = await bag.pairingApi.exchangePairingCode(pair.code, {
      apiBaseUrl: 'https://bacarguard.web.app/api'
    });

    assert.ok(exchanged.password);
    assert.equal(exchanged.config.username, created.username);
    assert.equal(exchanged.config.password, exchanged.password);
    assert.equal(exchanged.config.doorId, 'puerta-p1');
    assert.equal(exchanged.config.readerId, 'INGRESO_P1');
    assert.equal(exchanged.config.apiBaseUrl, 'https://bacarguard.web.app/api');
    assert.notEqual(bag.users.get(created.username).password, oldHash);
    assert.ok(await bcrypt.compare(exchanged.password, bag.users.get(created.username).password));
  });

  it('un solo uso: segundo canje falla con mensaje genérico', async () => {
    const created = await bag.lectoresApi.createLector({
      nombre: 'Ingreso',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });
    const pair = await bag.pairingApi.createPairingCode(created.lector.id);
    await bag.pairingApi.exchangePairingCode(pair.code, {
      apiBaseUrl: 'https://bacarguard.web.app/api'
    });

    await assert.rejects(
      () => bag.pairingApi.exchangePairingCode(pair.code, {
        apiBaseUrl: 'https://bacarguard.web.app/api'
      }),
      (err) => err.code === 'invalid_pairing_code'
        && err.message === bag.pairingApi.INVALID_CODE_MESSAGE
    );
  });

  it('código expirado → mismo error genérico', async () => {
    const created = await bag.lectoresApi.createLector({
      nombre: 'Ingreso',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });
    const pair = await bag.pairingApi.createPairingCode(created.lector.id);
    const stored = bag.pairingCodes.get(pair.code);
    stored.expiresAt = Date.now() - 1000;
    bag.pairingCodes.set(pair.code, stored);

    await assert.rejects(
      () => bag.pairingApi.exchangePairingCode(pair.code, {
        apiBaseUrl: 'https://bacarguard.web.app/api'
      }),
      (err) => err.code === 'invalid_pairing_code'
    );
  });

  it('código inexistente / formato inválido → genérico', async () => {
    await assert.rejects(
      () => bag.pairingApi.exchangePairingCode('000000', {
        apiBaseUrl: 'https://bacarguard.web.app/api'
      }),
      (err) => err.code === 'invalid_pairing_code'
    );
    await assert.rejects(
      () => bag.pairingApi.exchangePairingCode('abc', {
        apiBaseUrl: 'https://bacarguard.web.app/api'
      }),
      (err) => err.code === 'invalid_pairing_code'
    );
  });
});
