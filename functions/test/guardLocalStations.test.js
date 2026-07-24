const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  toEstacionMeta,
  enrichDoorsWithLocalStations
} = require('../lib/guardLocalStations');

describe('guardLocalStations', () => {
  it('toEstacionMeta exige IP + secreto y estación activa', () => {
    assert.equal(toEstacionMeta('e1', {
      nombre: 'A',
      direccionRedLocal: '192.168.1.50',
      secretoLocal: 'sec',
      activa: true
    }).direccionRedLocal, '192.168.1.50');

    assert.equal(toEstacionMeta('e1', {
      direccionRedLocal: '192.168.1.50',
      secretoLocal: '',
      activa: true
    }), null);

    assert.equal(toEstacionMeta('e1', {
      direccionRedLocal: '192.168.1.50',
      secretoLocal: 'sec',
      activa: false
    }), null);
  });

  it('enrichDoorsWithLocalStations mapea doorId → estación vía lectores', async () => {
    const firestorePath = require.resolve('../firestore');
    const original = require.cache[firestorePath];

    const lectores = new Map([
      ['l1', { doorId: 'puerta-p1', estacionId: 'est-1' }],
      ['l2', { doorId: 'puerta-p2', estacionId: '' }]
    ]);
    const estaciones = new Map([
      ['est-1', {
        nombre: 'Mini',
        direccionRedLocal: '192.168.1.50',
        puertoServidorLocal: 8787,
        secretoLocal: 'sec-abc',
        activa: true
      }]
    ]);

    const makeSnap = (store) => ({
      docs: [...store.entries()].map(([id, data]) => ({
        id,
        data: () => ({ ...data })
      }))
    });

    require.cache[firestorePath] = {
      id: firestorePath,
      filename: firestorePath,
      loaded: true,
      exports: {
        db: {
          collection(name) {
            return {
              async get() {
                return makeSnap(name === 'estaciones' ? estaciones : lectores);
              }
            };
          }
        },
        FieldValue: {}
      }
    };

    // Re-require module under test with mocked firestore
    const modPath = require.resolve('../lib/guardLocalStations');
    delete require.cache[modPath];
    const api = require('../lib/guardLocalStations');

    try {
      const doors = await api.enrichDoorsWithLocalStations([
        { id: 'puerta-p1', name: 'P1', relayMode: 'local' },
        { id: 'puerta-p2', name: 'P2' }
      ]);
      assert.equal(doors[0].relayMode, 'local');
      assert.equal(doors[0].localStation.direccionRedLocal, '192.168.1.50');
      assert.equal(doors[0].localStation.secretoLocal, 'sec-abc');
      assert.equal(doors[1].localStation, null);
      assert.equal(doors[1].relayMode, 'cloud');
    } finally {
      if (original) require.cache[firestorePath] = original;
      else delete require.cache[firestorePath];
      delete require.cache[modPath];
    }
  });
});
