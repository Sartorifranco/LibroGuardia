/**
 * Puente de citaciones: /health público mínimo y secreto enmascarado en admin.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const authPath = require.resolve('../middleware/auth');

const SECRET = 'secreto-del-puente-citaciones-XY';

const setup = () => {
  const settings = {
    citacionesBridge: {
      enabled: true,
      bridgeSecret: SECRET,
      lastSyncAt: '2026-07-03T10:00:00.000Z',
      lastSyncFile: 'C:/carpeta/privada/citaciones-julio.xlsx',
      lastSyncCount: 42,
      lastSyncError: 'ENOENT C:/carpeta/privada'
    }
  };
  const writes = [];
  const docRef = (name, id) => ({
    async get() {
      const data = name === 'settings' ? settings[id] : undefined;
      return { exists: Boolean(data), id, data: () => (data ? { ...data } : undefined) };
    },
    async set(payload, opts = {}) {
      writes.push({ name, id, payload });
      if (name === 'settings') settings[id] = opts.merge ? { ...(settings[id] || {}), ...payload } : payload;
    }
  });
  const query = (name) => ({
    doc: (id) => docRef(name, id),
    where() { return query(name); },
    limit() { return query(name); },
    orderBy() { return query(name); },
    async get() { return { empty: true, docs: [], size: 0 }; }
  });

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: { collection: (name) => query(name), batch: () => ({ set() {}, delete() {}, async commit() {} }) },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP', increment: (n) => n },
      Timestamp: { fromDate: (d) => d }
    }
  };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      auth: (req, _res, next) => { req.user = { id: 'admin', username: 'admin' }; next(); },
      requirePermission: () => (_req, _res, next) => next()
    }
  };
  ['../routes/authorizations', '../citacionesBridge', '../authorizations'].forEach((rel) => {
    delete require.cache[require.resolve(rel)];
  });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(require('../routes/authorizations'));
  return { app, settings, writes };
};

const withServer = async (app, fn) => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
};

describe('citaciones bridge: exposición de datos', () => {
  it('GET /api/bridge/citaciones/health devuelve solo { ok, lastSyncAt, hasSyncError }', async () => {
    const { app } = setup();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/bridge/citaciones/health`);
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(data, { ok: true, lastSyncAt: '2026-07-03T10:00:00.000Z', hasSyncError: true });
    });
  });

  it('GET /api/admin/citaciones-bridge enmascara el secreto ("••••" + 2 últimos)', async () => {
    const { app } = setup();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/admin/citaciones-bridge`);
      const data = await res.json();
      assert.equal(data.config.bridgeSecret, '••••XY');
      assert.ok(!JSON.stringify(data).includes(SECRET));
    });
  });

  it('PUT con el secreto enmascarado no pisa el secreto real', async () => {
    const { app, settings } = setup();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/admin/citaciones-bridge`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, bridgeSecret: '••••XY' })
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(settings.citacionesBridge.bridgeSecret, SECRET);
      assert.equal(data.config.bridgeSecret, '••••XY');
    });
  });
});
