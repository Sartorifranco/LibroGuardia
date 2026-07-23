/**
 * Test de unicidad legajo/DNI al editar persona (ruta peopleDoors).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const firestorePath = require.resolve('../firestore');
const authPath = require.resolve('../middleware/auth');
const peopleDoorsPath = require.resolve('../routes/peopleDoors');

const installPeopleDoorsMock = () => {
  const people = new Map();

  const makeDocRef = (id) => ({
    id,
    async get() {
      const data = people.get(id);
      return {
        exists: Boolean(data),
        id,
        ref: makeDocRef(id),
        data: () => (data ? { ...data } : undefined)
      };
    },
    async update(payload) {
      const prev = people.get(id) || {};
      const next = { ...prev };
      Object.entries(payload).forEach(([k, v]) => {
        if (v && typeof v === 'object' && v._methodName === 'serverTimestamp') {
          next[k] = new Date();
        } else {
          next[k] = v;
        }
      });
      people.set(id, next);
    }
  });

  const makeQuery = (filters = []) => ({
    where(field, op, value) {
      return makeQuery([...filters, { field, op, value }]);
    },
    limit(n) {
      return makeQuery([...filters, { limit: n }]);
    },
    async get() {
      let rows = [...people.entries()].map(([id, data]) => ({ id, ...data }));
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
            ref: makeDocRef(id),
            data: () => ({ ...data })
          };
        }),
        size: rows.length
      };
    }
  });

  const mockDb = {
    collection() {
      return {
        doc(id) {
          return makeDocRef(id);
        },
        where(field, op, value) {
          return makeQuery([{ field, op, value }]);
        },
        limit(n) {
          return makeQuery([{ limit: n }]);
        },
        async get() {
          return makeQuery([{ limit: 800 }]).get();
        }
      };
    }
  };

  const FieldValue = {
    serverTimestamp: () => ({ _methodName: 'serverTimestamp' })
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: { db: mockDb, FieldValue }
  };

  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      auth: (req, _res, next) => {
        req.user = { id: 'admin', role: 'admin', permissions: ['access.doors.manage'] };
        next();
      },
      requireAnyPermission: () => (_req, _res, next) => next()
    }
  };

  delete require.cache[peopleDoorsPath];
  // También invalidar peopleProfileUpdate si quedó cacheado con firestore real
  const profilePath = require.resolve('../lib/peopleProfileUpdate');
  delete require.cache[profilePath];
  const router = require('../routes/peopleDoors');

  return { people, router };
};

const withServer = async (router, fn) => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const requestJson = async (port, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
};

describe('peopleDoors PUT perfil', () => {
  let originalFirestore;
  let originalAuth;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath]?.exports;
    originalAuth = require.cache[authPath]?.exports;
  });

  afterEach(() => {
    if (originalFirestore) require.cache[firestorePath].exports = originalFirestore;
    if (originalAuth) {
      require.cache[authPath] = {
        id: authPath,
        filename: authPath,
        loaded: true,
        exports: originalAuth
      };
    }
    delete require.cache[peopleDoorsPath];
  });

  it('rechaza nombre vacío con 400', async () => {
    const { people, router } = installPeopleDoorsMock();
    people.set('p1', {
      nombre: 'Original',
      legajoNormalized: '100',
      dniNormalized: '11111111',
      active: true,
      allowedDoorIds: ['puerta-p1']
    });

    await withServer(router, async (port) => {
      const res = await requestJson(port, 'PUT', '/api/admin/people/p1/allowed-doors', {
        name: '  ',
        allowedDoorIds: ['puerta-p1']
      });
      assert.equal(res.status, 400);
      assert.match(res.payload.message, /nombre/i);
    });
  });

  it('rechaza legajo duplicado con 409', async () => {
    const { people, router } = installPeopleDoorsMock();
    people.set('p1', {
      nombre: 'Uno',
      legajoNormalized: '100',
      dniNormalized: '11111111',
      active: true,
      allowedDoorIds: []
    });
    people.set('p2', {
      nombre: 'Dos',
      legajoNormalized: '200',
      dniNormalized: '22222222',
      active: true,
      allowedDoorIds: []
    });

    await withServer(router, async (port) => {
      const res = await requestJson(port, 'PUT', '/api/admin/people/p1/allowed-doors', {
        name: 'Uno',
        legajo: '200',
        idNumber: '11111111',
        active: true,
        allowedDoorIds: []
      });
      assert.equal(res.status, 409);
      assert.match(res.payload.message, /legajo/i);
    });
  });

  it('rechaza DNI duplicado con 409', async () => {
    const { people, router } = installPeopleDoorsMock();
    people.set('p1', {
      nombre: 'Uno',
      legajoNormalized: '100',
      dniNormalized: '11111111',
      active: true,
      allowedDoorIds: []
    });
    people.set('p2', {
      nombre: 'Dos',
      legajoNormalized: '200',
      dniNormalized: '22222222',
      active: true,
      allowedDoorIds: []
    });

    await withServer(router, async (port) => {
      const res = await requestJson(port, 'PUT', '/api/admin/people/p1/allowed-doors', {
        name: 'Uno',
        legajo: '100',
        idNumber: '22222222',
        active: true,
        allowedDoorIds: []
      });
      assert.equal(res.status, 409);
      assert.match(res.payload.message, /DNI/i);
    });
  });

  it('guarda datos básicos + puertas juntos', async () => {
    const { people, router } = installPeopleDoorsMock();
    people.set('p1', {
      nombre: 'Viejo',
      legajoNormalized: '100',
      dniNormalized: '11111111',
      active: true,
      allowedDoorIds: []
    });

    await withServer(router, async (port) => {
      const res = await requestJson(port, 'PUT', '/api/admin/people/p1/allowed-doors', {
        name: 'Nuevo Nombre',
        legajo: '0100',
        idNumber: '11.111.111',
        active: false,
        notas: 'baja temporal',
        allowedDoorIds: ['puerta-p1', 'puerta-p2']
      });
      assert.equal(res.status, 200);
      assert.equal(res.payload.person.name, 'Nuevo Nombre');
      assert.equal(res.payload.person.legajo, '100');
      assert.equal(res.payload.person.idNumber, '11111111');
      assert.equal(res.payload.person.active, false);
      assert.equal(res.payload.person.notas, 'baja temporal');
      assert.deepEqual(res.payload.person.allowedDoorIds, ['puerta-p1', 'puerta-p2']);
      assert.equal(people.get('p1').active, false);
    });
  });
});
