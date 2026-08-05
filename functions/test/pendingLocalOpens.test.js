const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');

/**
 * Tests livianos del contrato de cola (sin Firestore real).
 * Validamos forma de payload vía una función local espejo de sanitize.
 */
const sanitizeQueuedRelay = (localRelay = {}) => {
  const driver = localRelay?.driver === 'generic_http' ? 'generic_http' : 'sr201';
  const pulseMode = localRelay.pulseMode === 'jog' ? 'jog' : 'timed';
  const pulseSeconds = Math.max(1, Math.min(99, Number(localRelay.pulseSeconds) || 3));
  if (driver === 'generic_http') {
    const httpUrl = String(localRelay?.httpUrl || '').trim();
    if (!httpUrl) return null;
    return {
      driver,
      host: '',
      port: 0,
      channel: 1,
      pulseMode,
      pulseSeconds,
      httpUrl,
      httpMethod: String(localRelay.httpMethod || 'POST').toUpperCase(),
      httpAuthToken: String(localRelay.httpAuthToken || '')
    };
  }
  const host = String(localRelay?.host || '').trim();
  if (!host) return null;
  return {
    driver: 'sr201',
    host,
    port: Number(localRelay.port) || 6722,
    channel: Number(localRelay.channel) === 2 ? 2 : 1,
    pulseMode,
    pulseSeconds,
    httpUrl: '',
    httpMethod: 'POST',
    httpAuthToken: ''
  };
};

describe('pending local open payload', () => {
  it('normaliza host/canal/segundos', () => {
    assert.deepEqual(
      sanitizeQueuedRelay({ host: '192.168.0.38', channel: 2, pulseSeconds: 5 }),
      {
        driver: 'sr201',
        host: '192.168.0.38',
        port: 6722,
        channel: 2,
        pulseMode: 'timed',
        pulseSeconds: 5,
        httpUrl: '',
        httpMethod: 'POST',
        httpAuthToken: ''
      }
    );
  });

  it('sin host → null (no encolar)', () => {
    assert.equal(sanitizeQueuedRelay({ channel: 1 }), null);
  });

  it('acepta HTTP genérico con httpUrl', () => {
    const payload = sanitizeQueuedRelay({
      driver: 'generic_http',
      httpUrl: 'http://192.168.0.50/open',
      httpMethod: 'POST',
      pulseSeconds: 3
    });
    assert.equal(payload.driver, 'generic_http');
    assert.equal(payload.httpUrl, 'http://192.168.0.50/open');
  });
});

/**
 * Mock de Firestore que registra los filtros de cada query y los ids borrados,
 * para poder afirmar sobre el costo de lectura y no solo sobre el resultado.
 */
const installFirestoreMock = (rows) => {
  const deleted = [];
  const queries = [];

  const makeQuery = (collectionName) => {
    const filters = [];
    const q = {
      where(field, op, value) {
        filters.push({ field, op, value });
        return q;
      },
      limit() { return q; },
      doc() { return { id: 'nuevo' }; },
      async get() {
        queries.push({ collectionName, filters: [...filters] });
        let matched = rows;
        for (const f of filters) {
          if (f.op === '==') matched = matched.filter((r) => r[f.field] === f.value);
        }
        return {
          empty: matched.length === 0,
          size: matched.length,
          docs: matched.map((row) => ({
            id: row.id,
            ref: { id: row.id },
            data: () => {
              const { id, ...rest } = row;
              return rest;
            }
          }))
        };
      }
    };
    return q;
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection: (name) => makeQuery(name),
        batch: () => ({
          delete(ref) { deleted.push(ref.id); },
          set() {},
          async commit() {}
        })
      },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }
    }
  };

  delete require.cache[require.resolve('../lib/pendingLocalOpens')];
  return { deleted, queries };
};

const enElFuturo = () => new Date(Date.now() + 30_000).toISOString();
const enElPasado = () => new Date(Date.now() - 60_000).toISOString();

describe('claimPendingLocalOpens', () => {
  it('entrega el pedido vigente y lo borra de la cola', async () => {
    const { deleted } = installFirestoreMock([
      { id: 'vivo', doorId: 'puerta-p1', status: 'pending', expiresAt: enElFuturo(), localRelay: { driver: 'sr201' } }
    ]);
    const { claimPendingLocalOpens } = require('../lib/pendingLocalOpens');

    const res = await claimPendingLocalOpens('puerta-p1');

    assert.equal(res.opens.length, 1);
    assert.equal(res.opens[0].id, 'vivo');
    assert.deepEqual(deleted, ['vivo']);
  });

  it('descarta el pedido vencido sin entregarlo, pero lo borra igual', async () => {
    const { deleted } = installFirestoreMock([
      { id: 'viejo', doorId: 'puerta-p1', status: 'pending', expiresAt: enElPasado() }
    ]);
    const { claimPendingLocalOpens } = require('../lib/pendingLocalOpens');

    const res = await claimPendingLocalOpens('puerta-p1');

    assert.equal(res.opens.length, 0);
    assert.deepEqual(deleted, ['viejo'], 'el vencido tiene que salir de la cola');
  });

  it('no toca los pedidos de otra puerta', async () => {
    const { deleted } = installFirestoreMock([
      { id: 'p1', doorId: 'puerta-p1', status: 'pending', expiresAt: enElFuturo() },
      { id: 'p2', doorId: 'puerta-p2', status: 'pending', expiresAt: enElFuturo() }
    ]);
    const { claimPendingLocalOpens } = require('../lib/pendingLocalOpens');

    const res = await claimPendingLocalOpens('puerta-p1');

    assert.deepEqual(res.opens.map((o) => o.id), ['p1']);
    assert.deepEqual(deleted, ['p1']);
  });

  // Guarda del costo: el poll corre cada ~2 s. Sin el filtro por status la
  // consulta traía todas las aperturas históricas de la puerta y cada poll
  // pagaba una lectura por cada una.
  it('filtra por status en la consulta, no en memoria', async () => {
    const { queries } = installFirestoreMock([
      { id: 'a', doorId: 'puerta-p1', status: 'pending', expiresAt: enElFuturo() }
    ]);
    const { claimPendingLocalOpens } = require('../lib/pendingLocalOpens');

    await claimPendingLocalOpens('puerta-p1');

    const campos = queries[0].filters.map((f) => f.field).sort();
    assert.deepEqual(campos, ['doorId', 'status']);
  });

  it('la cola vacía no devuelve aperturas ni escribe', async () => {
    const { deleted } = installFirestoreMock([]);
    const { claimPendingLocalOpens } = require('../lib/pendingLocalOpens');

    const res = await claimPendingLocalOpens('puerta-p1');

    assert.equal(res.opens.length, 0);
    assert.equal(deleted.length, 0);
  });

  it('respeta el límite de pedidos por vuelta', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `o${i}`, doorId: 'puerta-p1', status: 'pending', expiresAt: enElFuturo()
    }));
    const { deleted } = installFirestoreMock(rows);
    const { claimPendingLocalOpens } = require('../lib/pendingLocalOpens');

    const res = await claimPendingLocalOpens('puerta-p1', { limit: 3 });

    assert.equal(res.opens.length, 3);
    assert.equal(deleted.length, 3, 'los que no entraron quedan para el próximo poll');
  });
});
