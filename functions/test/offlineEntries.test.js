const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const offlinePath = require.resolve('../lib/offlineEntries');

const installEntriesMock = () => {
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

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection(name) {
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
  return {
    docs,
    api: require('../lib/offlineEntries')
  };
};

describe('offlineEntries', () => {
  let bag;

  beforeEach(() => {
    bag = installEntriesMock();
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
    }], { actorId: 'kiosk.p1' });

    assert.equal(result.accepted, 1);
    assert.equal(result.skipped, 0);
    const docId = bag.api.offlineEntryDocId('local-abc-1');
    const stored = bag.docs.get(docId);
    assert.ok(stored);
    assert.equal(stored.entrySource, 'kiosk_offline');
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

    const first = await bag.api.ingestOfflineEntries([event]);
    const second = await bag.api.ingestOfflineEntries([event]);

    assert.equal(first.accepted, 1);
    assert.equal(second.accepted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.results[0].status, 'duplicate');
    assert.equal(bag.docs.size, 1);
  });
});
