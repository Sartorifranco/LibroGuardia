const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const firestorePath = require.resolve('../firestore');
const lectoresPath = require.resolve('../lib/lectores');
const doorsConfigPath = require.resolve('../lib/doorsConfig');
const rolesPath = require.resolve('../roles');

const installLectoresMock = () => {
  const users = new Map();
  const roles = new Map();
  const lectores = new Map();
  let autoId = 0;

  const makeDocRef = (collectionName, id) => ({
    id,
    async get() {
      const store = collectionName === 'users' ? users
        : collectionName === 'roles' ? roles
          : lectores;
      const data = store.get(id);
      return {
        exists: Boolean(data),
        id,
        ref: makeDocRef(collectionName, id),
        data: () => (data ? { ...data } : undefined)
      };
    },
    async set(payload, opts = {}) {
      const store = collectionName === 'users' ? users
        : collectionName === 'roles' ? roles
          : lectores;
      const prev = store.get(id) || {};
      store.set(id, opts.merge ? { ...prev, ...payload } : { ...payload });
    },
    async update(payload) {
      const store = collectionName === 'users' ? users
        : collectionName === 'roles' ? roles
          : lectores;
      const prev = store.get(id) || {};
      store.set(id, { ...prev, ...payload });
    },
    async delete() {
      const store = collectionName === 'users' ? users
        : collectionName === 'roles' ? roles
          : lectores;
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
    orderBy() {
      return makeQuery(collectionName, filters);
    },
    async get() {
      const store = collectionName === 'users' ? users
        : collectionName === 'roles' ? roles
          : lectores;
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
        }]
      }),
      findDoorById: (config, doorId) => (config.doors || []).find((d) => d.id === doorId) || null
    }
  };

  delete require.cache[rolesPath];
  delete require.cache[lectoresPath];

  return {
    users,
    roles,
    lectores,
    api: require('../lib/lectores')
  };
};

describe('lectores — helpers', () => {
  let originalFirestore;
  let originalDoors;
  let originalRoles;
  let bag;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
    originalDoors = require.cache[doorsConfigPath];
    originalRoles = require.cache[rolesPath];
    bag = installLectoresMock();
  });

  afterEach(() => {
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
    if (originalDoors) require.cache[doorsConfigPath] = originalDoors;
    else delete require.cache[doorsConfigPath];
    if (originalRoles) require.cache[rolesPath] = originalRoles;
    else delete require.cache[rolesPath];
    delete require.cache[lectoresPath];
  });

  it('resolveConnectionStatus: verde / amarillo / rojo', () => {
    const { resolveConnectionStatus, STATUS_GREEN_MS, STATUS_YELLOW_MS } = bag.api;
    const now = 1_000_000;
    assert.equal(resolveConnectionStatus(null, now), 'offline');
    assert.equal(resolveConnectionStatus(now - 60_000, now), 'online');
    assert.equal(resolveConnectionStatus(now - STATUS_GREEN_MS + 1, now), 'online');
    assert.equal(resolveConnectionStatus(now - STATUS_GREEN_MS - 1, now), 'stale');
    assert.equal(resolveConnectionStatus(now - STATUS_YELLOW_MS - 1, now), 'offline');
  });

  it('buildDoorReaderConfig arma el JSON del bridge', () => {
    const cfg = bag.api.buildDoorReaderConfig({
      apiBaseUrl: 'https://bacarguard.web.app/api/',
      username: 'kiosk.p1',
      password: 'secret',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      lectorId: 'abc'
    });
    assert.equal(cfg.apiBaseUrl, 'https://bacarguard.web.app/api');
    assert.equal(cfg.username, 'kiosk.p1');
    assert.equal(cfg.password, 'secret');
    assert.equal(cfg.doorId, 'puerta-p1');
    assert.equal(cfg.readerId, 'INGRESO_P1');
    assert.equal(cfg.lectorId, 'abc');
    assert.equal(cfg.baudRate, 9600);
  });

  it('CRUD crea usuario kiosk + config con password one-shot', async () => {
    const result = await bag.api.createLector({
      nombre: 'Lector ingreso P1',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    }, { apiBaseUrl: 'https://bacarguard.web.app/api' });

    assert.ok(result.lector.id);
    assert.ok(result.password.length >= 16);
    assert.equal(result.config.password, result.password);
    assert.equal(result.config.doorId, 'puerta-p1');
    assert.equal(result.config.readerId, 'INGRESO_P1');
    assert.equal(result.lector.usuarioSistemaId, result.username);

    const user = bag.users.get(result.username);
    assert.ok(user);
    assert.equal(user.role, 'kiosk_puerta');
    assert.ok(await bcrypt.compare(result.password, user.password));

    const listed = await bag.api.listLectores();
    assert.equal(listed.length, 1);
  });

  it('regenerateCredentials invalida la password anterior', async () => {
    const created = await bag.api.createLector({
      nombre: 'Lector A',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    });
    const oldPassword = created.password;
    const username = created.username;

    const regen = await bag.api.regenerateCredentials(created.lector.id, {
      apiBaseUrl: 'https://bacarguard.web.app/api'
    });
    assert.notEqual(regen.password, oldPassword);
    assert.equal(regen.config.password, regen.password);

    const user = bag.users.get(username);
    assert.equal(await bcrypt.compare(oldPassword, user.password), false);
    assert.equal(await bcrypt.compare(regen.password, user.password), true);
    assert.equal(user.passwordVersion, 2);
  });

  it('heartbeat actualiza ultimaConexion', async () => {
    const created = await bag.api.createLector({
      nombre: 'Lector HB',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    });
    assert.equal(created.lector.ultimaConexion, null);

    const touched = await bag.api.touchHeartbeat({
      username: created.username,
      lectorId: created.lector.id
    });
    assert.equal(touched.ultimaConexion, 'SERVER_TIMESTAMP');
    assert.equal(touched.forceResync, false);

    const stored = bag.lectores.get(created.lector.id);
    assert.equal(stored.ultimaConexion, 'SERVER_TIMESTAMP');
  });

  it('forceResync: requestForceResync + heartbeat lo consume una sola vez', async () => {
    const created = await bag.api.createLector({
      nombre: 'Lector Resync',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    });

    const requested = await bag.api.requestForceResync(created.lector.id);
    assert.equal(requested.forceResync, true);
    assert.equal(bag.lectores.get(created.lector.id).forceResync, true);

    const firstHb = await bag.api.touchHeartbeat({
      username: created.username,
      lectorId: created.lector.id
    });
    assert.equal(firstHb.forceResync, true);
    assert.equal(bag.lectores.get(created.lector.id).forceResync, false);

    const secondHb = await bag.api.touchHeartbeat({
      username: created.username,
      lectorId: created.lector.id
    });
    assert.equal(secondHb.forceResync, false);
  });

  it('resolveAuthUsername prioriza username sobre id (bug heartbeat)', () => {
    const { resolveAuthUsername } = bag.api;
    // Caso del bug: JWT con id interno distinto del username legible.
    assert.equal(
      resolveAuthUsername({ id: 'uuid-interno-abc', username: 'kiosk.puerta-p1' }),
      'kiosk.puerta-p1'
    );
    // Fallback cuando el JWT aún no trae username (tokens viejos).
    assert.equal(
      resolveAuthUsername({ id: 'kiosk.puerta-p1' }),
      'kiosk.puerta-p1'
    );
    assert.equal(resolveAuthUsername({}), '');
  });

  it('heartbeat falla con id interno y pasa con username del JWT', async () => {
    const created = await bag.api.createLector({
      nombre: 'Lector ID vs Username',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      direction: 'ingreso'
    });

    const jwtPayload = {
      id: 'uuid-interno-distinto-del-username',
      username: created.username
    };

    // Orden viejo (bug): id || username → usa el id interno → no matchea usuarioSistemaId
    const buggyUsername = jwtPayload.id || jwtPayload.username;
    await assert.rejects(
      () => bag.api.touchHeartbeat({
        username: buggyUsername,
        lectorId: created.lector.id
      }),
      (err) => err.status === 403
    );

    // Fix: username || id vía resolveAuthUsername
    const fixedUsername = bag.api.resolveAuthUsername(jwtPayload);
    assert.equal(fixedUsername, created.username);
    const touched = await bag.api.touchHeartbeat({
      username: fixedUsername,
      lectorId: created.lector.id
    });
    assert.equal(touched.ultimaConexion, 'SERVER_TIMESTAMP');
  });

  it('deleteLector borra también el usuario de sistema', async () => {
    const created = await bag.api.createLector({
      nombre: 'Lector Del',
      doorId: 'puerta-p1',
      readerId: 'EGRESO_P1',
      direction: 'egreso'
    });
    assert.ok(bag.users.has(created.username));
    await bag.api.deleteLector(created.lector.id);
    assert.equal(bag.lectores.has(created.lector.id), false);
    assert.equal(bag.users.has(created.username), false);
  });

  it('rechaza readerId inexistente en la puerta', async () => {
    await assert.rejects(
      () => bag.api.createLector({
        nombre: 'X',
        doorId: 'puerta-p1',
        readerId: 'NO-EXISTE',
        direction: 'ingreso'
      }),
      (err) => err.code === 'unknown_reader' && err.status === 400
    );
  });
});
