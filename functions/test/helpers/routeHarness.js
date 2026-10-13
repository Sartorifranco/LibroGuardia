/**
 * Harness para tests a nivel de ruta HTTP sin dependencias extra:
 * - Firestore en memoria (subset usado por las rutas) inyectado vía require.cache.
 * - App Express mínima con los routers pedidos, escuchando en un puerto efímero.
 * - fetch nativo (Node 20) para las requests.
 */

const path = require('path');
const http = require('http');

const FUNCTIONS_DIR = path.resolve(__dirname, '..', '..');
const firestorePath = require.resolve('../../firestore');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const createMemoryDb = (initial = {}) => {
  const collections = new Map();
  let autoId = 0;

  const store = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  Object.entries(initial).forEach(([name, docs]) => {
    Object.entries(docs || {}).forEach(([id, data]) => store(name).set(id, clone(data)));
  });

  const makeSnap = (name, id) => {
    const data = store(name).get(id);
    return {
      id,
      exists: data !== undefined,
      ref: makeDocRef(name, id),
      data: () => clone(data)
    };
  };

  function makeDocRef(name, id) {
    return {
      id,
      path: `${name}/${id}`,
      async get() { return makeSnap(name, id); },
      async set(payload, opts = {}) {
        const prev = store(name).get(id) || {};
        store(name).set(id, opts.merge ? { ...prev, ...clone(payload) } : clone(payload));
      },
      async update(payload) {
        if (!store(name).has(id)) {
          const err = new Error(`NOT_FOUND ${name}/${id}`);
          err.code = 5;
          throw err;
        }
        store(name).set(id, { ...store(name).get(id), ...clone(payload) });
      },
      async delete() { store(name).delete(id); },
      collection(sub) { return makeCollection(`${name}/${id}/${sub}`); }
    };
  }

  const makeQuery = (name, filters = [], limitN = null) => ({
    where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }], limitN); },
    orderBy() { return makeQuery(name, filters, limitN); },
    limit(n) { return makeQuery(name, filters, n); },
    startAfter() { return makeQuery(name, filters, limitN); },
    async get() {
      let ids = [...store(name).keys()];
      ids = ids.filter((id) => {
        const row = store(name).get(id);
        return filters.every((f) => {
          const v = row[f.field];
          if (f.op === '==') return v === f.value;
          if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(v);
          if (f.op === 'array-contains') return Array.isArray(v) && v.includes(f.value);
          if (f.op === '>=') return v >= f.value;
          if (f.op === '<=') return v <= f.value;
          return true;
        });
      });
      if (limitN != null) ids = ids.slice(0, limitN);
      const docs = ids.map((id) => makeSnap(name, id));
      return { empty: docs.length === 0, size: docs.length, docs };
    }
  });

  function makeCollection(name) {
    return {
      ...makeQuery(name),
      doc(id) { return makeDocRef(name, id || `auto-${++autoId}`); },
      async add(payload) {
        const ref = makeDocRef(name, `auto-${++autoId}`);
        await ref.set(payload);
        return ref;
      }
    };
  }

  const db = {
    collection: (name) => makeCollection(name),
    batch() {
      const ops = [];
      return {
        set: (ref, payload, opts) => ops.push(() => ref.set(payload, opts)),
        update: (ref, payload) => ops.push(() => ref.update(payload)),
        delete: (ref) => ops.push(() => ref.delete()),
        async commit() { for (const op of ops) await op(); }
      };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, payload, opts) => { writes.push(() => ref.set(payload, opts)); return tx; },
        update: (ref, payload) => { writes.push(() => ref.update(payload)); return tx; },
        delete: (ref) => { writes.push(() => ref.delete()); return tx; }
      };
      const result = await fn(tx);
      for (const write of writes) await write();
      return result;
    }
  };

  return {
    db,
    getDoc: (name, id) => clone(store(name).get(id)),
    setDoc: (name, id, data) => store(name).set(id, clone(data)),
    hasDoc: (name, id) => store(name).has(id)
  };
};

const FieldValue = {
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  increment: (n) => n,
  arrayUnion: (...items) => items,
  delete: () => null
};

const Timestamp = {
  now: () => ({ toDate: () => new Date(), toMillis: () => Date.now() }),
  fromDate: (d) => ({ toDate: () => d, toMillis: () => d.getTime() })
};

/** Borra del cache todos los módulos propios de functions/ (no node_modules ni tests). */
const purgeFunctionsModules = () => {
  Object.keys(require.cache).forEach((key) => {
    if (!key.startsWith(FUNCTIONS_DIR)) return;
    if (key.includes(`${path.sep}node_modules${path.sep}`)) return;
    if (key.includes(`${path.sep}test${path.sep}`)) return;
    delete require.cache[key];
  });
};

const stubModule = (relativeFromFunctions, exportsObj) => {
  const resolved = require.resolve(path.join(FUNCTIONS_DIR, relativeFromFunctions));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj
  };
};

/**
 * Instala Firestore en memoria + stubs y devuelve helpers.
 * @param {{ initial?: object, stubs?: Record<string, object> }} opts
 */
const setupHarness = ({ initial = {}, stubs = {} } = {}) => {
  purgeFunctionsModules();
  const mem = createMemoryDb(initial);
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: { admin: {}, db: mem.db, FieldValue, Timestamp }
  };
  Object.entries(stubs).forEach(([rel, exp]) => stubModule(rel, exp));
  return mem;
};

const startRouters = async (routerPaths = []) => {
  const express = require('express');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  routerPaths.forEach((rel) => app.use(require(path.join(FUNCTIONS_DIR, rel))));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = async (method, urlPath, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text };
  };

  const close = () => new Promise((resolve) => server.close(resolve));
  return { baseUrl, request, close };
};

/** Docs de roles desde DEFAULT_ROLE_PERMISSIONS (evita el seed en listRoles). */
const defaultRoleDocs = (extra = {}) => {
  const { DEFAULT_ROLE_PERMISSIONS } = require('../../permissions');
  const docs = {};
  Object.entries(DEFAULT_ROLE_PERMISSIONS).forEach(([id, permissions], i) => {
    docs[id] = { label: id, permissions, sortOrder: i + 1, isSystem: true };
  });
  Object.entries(extra).forEach(([id, permissions]) => {
    docs[id] = { label: id, permissions, sortOrder: 90, isSystem: false };
  });
  return docs;
};

const TEST_JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

const signTestToken = (payload, opts = {}) => {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { passwordVersion: 1, permissions: [], ...payload },
    opts.secret || TEST_JWT_SECRET,
    { algorithm: opts.algorithm || 'HS256', expiresIn: '1h' }
  );
};

module.exports = {
  createMemoryDb,
  setupHarness,
  startRouters,
  stubModule,
  purgeFunctionsModules,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET,
  FieldValue,
  Timestamp
};
