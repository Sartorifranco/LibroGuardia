/**
 * Una estación solo puede reclamar aperturas en cola de SUS puertas.
 * Puerta ajena → 403 y el pedido queda en la cola (no se borra).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const authPath = require.resolve('../middleware/auth');

const setupApp = ({ pending = [], lectores = [], username = 'kiosk.p1' } = {}) => {
  const queue = [...pending];
  const deleted = [];

  const makeQuery = (name, filters = []) => ({
    where(field, op, value) {
      return makeQuery(name, [...filters, { field, op, value }]);
    },
    limit() {
      return makeQuery(name, filters);
    },
    doc(id) {
      return {
        id,
        async get() {
          const row = (name === 'lectores' ? lectores : queue).find((r) => r.id === id);
          return { exists: Boolean(row), id, ref: this, data: () => (row ? { ...row } : undefined) };
        },
        async set() {}
      };
    },
    async get() {
      const source = name === 'lectores' ? lectores : (name === 'pending_local_opens' ? queue : []);
      const rows = source.filter((row) => filters.every((f) => row[f.field] === f.value));
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((row) => ({
          id: row.id,
          ref: {
            id: row.id,
            async set() {},
            async get() { return { exists: true, id: row.id, data: () => ({ ...row }) }; }
          },
          data: () => ({ ...row })
        }))
      };
    }
  });

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection: (name) => makeQuery(name),
        batch: () => {
          const ops = [];
          return {
            delete(ref) { ops.push(ref.id); },
            set() {},
            async commit() {
              ops.forEach((id) => {
                deleted.push(id);
                const idx = queue.findIndex((r) => r.id === id);
                if (idx >= 0) queue.splice(idx, 1);
              });
            }
          };
        }
      },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
      Timestamp: { fromDate: (d) => d }
    }
  };

  // Stub del middleware (lo edita otro equipo; acá solo importa req.user).
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      auth: (req, _res, next) => { req.user = { id: username, username }; next(); },
      requirePermission: () => (_req, _res, next) => next()
    }
  };

  [
    '../routes/lectores',
    '../lib/lectores',
    '../lib/pendingLocalOpens',
    '../lib/lectorPairing',
    '../lib/loginRateLimit',
    '../lib/auditLog'
  ].forEach((rel) => { delete require.cache[require.resolve(rel)]; });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(require('../routes/lectores'));
  return { app, queue, deleted };
};

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

const post = async (server, path, body) => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const futuro = () => new Date(Date.now() + 30_000).toISOString();

describe('POST /api/lectores/claim-pending-opens', () => {
  it('puerta ajena → 403 y el pedido NO se borra', async () => {
    const { app, queue, deleted } = setupApp({
      lectores: [{ id: 'l1', usuarioSistemaId: 'kiosk.p1', doorId: 'puerta-p1' }],
      pending: [{ id: 'open-p2', doorId: 'puerta-p2', status: 'pending', expiresAt: futuro() }]
    });
    const server = await listen(app);
    try {
      const res = await post(server, '/api/lectores/claim-pending-opens', { doorId: 'puerta-p2' });
      assert.equal(res.status, 403);
      assert.deepEqual(deleted, []);
      assert.equal(queue.length, 1);
      assert.equal(queue[0].id, 'open-p2');
    } finally {
      server.close();
    }
  });

  it('puerta propia → entrega y consume el pedido', async () => {
    const { app, queue } = setupApp({
      lectores: [{ id: 'l1', usuarioSistemaId: 'kiosk.p1', doorId: 'puerta-p1' }],
      pending: [{ id: 'open-p1', doorId: 'puerta-p1', status: 'pending', expiresAt: futuro() }]
    });
    const server = await listen(app);
    try {
      const res = await post(server, '/api/lectores/claim-pending-opens', { doorId: 'puerta-p1' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.opens.map((o) => o.id), ['open-p1']);
      assert.equal(queue.length, 0);
    } finally {
      server.close();
    }
  });

  it('heartbeat con doorId ajeno no reclama ni borra (sigue respondiendo el heartbeat)', async () => {
    const { app, queue, deleted } = setupApp({
      lectores: [{ id: 'l1', usuarioSistemaId: 'kiosk.p1', doorId: 'puerta-p1' }],
      pending: [{ id: 'open-p2', doorId: 'puerta-p2', status: 'pending', expiresAt: futuro() }]
    });
    const server = await listen(app);
    try {
      const res = await post(server, '/api/lectores/heartbeat', { doorId: 'puerta-p2' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.pendingOpens, []);
      assert.equal(res.data.pendingOpensError, 'puerta_no_vinculada');
      assert.deepEqual(deleted, []);
      assert.equal(queue.length, 1);
    } finally {
      server.close();
    }
  });
});

describe('claimPendingLocalOpens (lib)', () => {
  it('sin allowedDoorIds → 403 sin consultar ni borrar', async () => {
    const { deleted } = setupApp({
      pending: [{ id: 'open-p1', doorId: 'puerta-p1', status: 'pending', expiresAt: futuro() }]
    });
    const { claimPendingLocalOpens } = require('../lib/pendingLocalOpens');
    await assert.rejects(() => claimPendingLocalOpens('puerta-p1'), (err) => err.status === 403);
    assert.deepEqual(deleted, []);
  });
});
