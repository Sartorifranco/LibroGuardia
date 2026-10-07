const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const offlinePath = require.resolve('../lib/offlineEntries');
const lectoresPath = require.resolve('../lib/lectores');

// "Ahora" fijo para que los eventos de julio 2026 no queden fuera de la ventana de 7 días.
const NOW_MS = Date.parse('2026-07-21T12:00:00.000-03:00');

const installEntriesMock = ({ lectores = [] } = {}) => {
  const docs = new Map();

  const makeRef = (id) => ({
    id,
    async get() {
      const data = docs.get(id);
      return {
        exists: Boolean(data),
        id,
        data: () => (data ? { ...data } : undefined)
      };
    },
    async set(payload) {
      docs.set(id, { ...payload });
    }
  });

  const lectoresQuery = (filters = []) => ({
    where(field, op, value) {
      return lectoresQuery([...filters, { field, op, value }]);
    },
    limit() {
      return lectoresQuery(filters);
    },
    async get() {
      const rows = lectores.filter((row) => filters.every((f) => row[f.field] === f.value));
      return {
        empty: rows.length === 0,
        docs: rows.map((row) => ({ id: row.id, data: () => ({ ...row }) }))
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
          if (name === 'lectores') return lectoresQuery();
          assert.equal(name, 'entries');
          return {
            doc(id) {
              return makeRef(id);
            }
          };
        }
      },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
      Timestamp: {
        fromDate: (d) => ({ __ts: d.toISOString() })
      }
    }
  };

  delete require.cache[offlinePath];
  delete require.cache[lectoresPath];
  return {
    docs,
    api: require('../lib/offlineEntries')
  };
};

describe('offlineEntries', () => {
  let bag;

  beforeEach(() => {
    bag = installEntriesMock({
      lectores: [{ id: 'lector-p1', usuarioSistemaId: 'kiosk.p1', doorId: 'puerta-p1' }]
    });
  });

  it('crea entry con timestamp del evento y entrySource kiosk_offline', async () => {
    const scannedAt = '2026-07-20T14:22:00.000-03:00';
    const result = await bag.api.ingestOfflineEntries([{
      offlineLocalId: 'local-abc-1',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      movementType: 'ingreso',
      timestamp: scannedAt,
      dniNormalized: '43926145',
      nombre: 'FACUNDO ARRAIGADA',
      authorized: true,
      authorizationType: 'permanent',
      relayTriggered: true
    }], { actorId: 'kiosk.p1', nowMs: NOW_MS });

    assert.equal(result.accepted, 1);
    assert.equal(result.skipped, 0);
    const docId = bag.api.offlineEntryDocId('local-abc-1');
    const stored = bag.docs.get(docId);
    assert.ok(stored);
    assert.equal(stored.entrySource, 'kiosk_offline');
    assert.equal(stored.source, 'offline_kiosk');
    assert.equal(stored.declaredByKiosk, true);
    assert.equal(stored.doorId, 'puerta-p1');
    assert.equal(stored.offlineLocalId, 'local-abc-1');
    assert.equal(stored.timestamp.__ts, new Date(scannedAt).toISOString());
    assert.equal(stored.authorized, true);
  });

  it('es idempotente si el mismo offlineLocalId llega dos veces', async () => {
    const event = {
      offlineLocalId: 'dup-1',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      timestamp: '2026-07-21T10:00:00.000Z',
      dniNormalized: '12345678',
      authorized: true
    };

    const first = await bag.api.ingestOfflineEntries([event], { actorId: 'kiosk.p1', nowMs: NOW_MS });
    const second = await bag.api.ingestOfflineEntries([event], { actorId: 'kiosk.p1', nowMs: NOW_MS });

    assert.equal(first.accepted, 1);
    assert.equal(second.accepted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.results[0].status, 'duplicate');
    assert.equal(bag.docs.size, 1);
  });

  it('sin campo authorized → se registra como NO autorizado (fail-closed)', async () => {
    const result = await bag.api.ingestOfflineEntries([{
      offlineLocalId: 'sin-auth-1',
      doorId: 'puerta-p1',
      timestamp: '2026-07-21T09:00:00.000-03:00',
      dniNormalized: '30111222'
    }], { actorId: 'kiosk.p1', nowMs: NOW_MS });
    assert.equal(result.accepted, 1);
    const stored = bag.docs.get(bag.api.offlineEntryDocId('sin-auth-1'));
    assert.equal(stored.authorized, false);
    assert.equal(stored.accessAuthorized, false);
    assert.equal(stored.denialReason, 'offline_deny');
  });

  it('timestamp de más de 7 días → rechazado (sin escribir)', async () => {
    const result = await bag.api.ingestOfflineEntries([{
      offlineLocalId: 'viejo-1',
      doorId: 'puerta-p1',
      timestamp: '2026-07-10T09:00:00.000-03:00',
      authorized: true
    }], { actorId: 'kiosk.p1', nowMs: NOW_MS });
    assert.equal(result.accepted, 0);
    assert.equal(result.rejected, 1);
    assert.equal(result.results[0].status, 'rejected');
    assert.equal(bag.docs.size, 0);
  });

  it('timestamp más de 5 min en el futuro → rechazado', async () => {
    const result = await bag.api.ingestOfflineEntries([{
      offlineLocalId: 'futuro-1',
      doorId: 'puerta-p1',
      timestamp: new Date(NOW_MS + 10 * 60 * 1000).toISOString(),
      authorized: true
    }], { actorId: 'kiosk.p1', nowMs: NOW_MS });
    assert.equal(result.rejected, 1);
    assert.equal(bag.docs.size, 0);
  });

  it('doorId no vinculado al usuario que sincroniza → rechazado', async () => {
    const result = await bag.api.ingestOfflineEntries([{
      offlineLocalId: 'ajena-1',
      doorId: 'puerta-p2',
      timestamp: '2026-07-21T09:00:00.000-03:00',
      authorized: true
    }], { actorId: 'kiosk.p1', nowMs: NOW_MS });
    assert.equal(result.rejected, 1);
    assert.match(result.results[0].message, /no está vinculada/);
    assert.equal(bag.docs.size, 0);
  });

  it('usuario sin lectores vinculados no puede declarar eventos', async () => {
    const result = await bag.api.ingestOfflineEntries([{
      offlineLocalId: 'x-1',
      doorId: 'puerta-p1',
      timestamp: '2026-07-21T09:00:00.000-03:00',
      authorized: true
    }], { actorId: 'admin', nowMs: NOW_MS });
    assert.equal(result.rejected, 1);
    assert.equal(bag.docs.size, 0);
  });
});
