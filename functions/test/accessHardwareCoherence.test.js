const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertOfflineCompatibleWithDoor,
  assertDoorsCompatibleWithOfflineLectores,
  isLocalRelayMode
} = require('../lib/accessHardwareCoherence');

describe('accessHardwareCoherence', () => {
  it('isLocalRelayMode solo acepta local', () => {
    assert.equal(isLocalRelayMode('local'), true);
    assert.equal(isLocalRelayMode('cloud'), false);
    assert.equal(isLocalRelayMode(undefined), false);
  });

  it('bloquea offline si la puerta es a distancia', () => {
    assert.throws(
      () => assertOfflineCompatibleWithDoor(
        { id: 'puerta-p1', name: 'Puerta 1', relayMode: 'cloud' },
        { offlineCache: true }
      ),
      (err) => err.status === 400 && err.code === 'offline_requires_local_relay'
    );
  });

  it('permite offline si la puerta es en planta', () => {
    assert.doesNotThrow(() => assertOfflineCompatibleWithDoor(
      { id: 'puerta-p1', name: 'Puerta 1', relayMode: 'local' },
      { offlineCache: true }
    ));
  });

  it('bloquea guardar puerta cloud si hay lectores offline', async () => {
    await assert.rejects(
      () => assertDoorsCompatibleWithOfflineLectores(
        [{ id: 'puerta-p1', name: 'Puerta 1', relayMode: 'cloud', active: true }],
        async () => ([
          { id: 'lec-1', doorId: 'puerta-p1', offlineCache: true, nombre: 'Ingreso' }
        ])
      ),
      (err) => err.status === 400 && err.code === 'cloud_relay_blocks_offline_lectores'
    );
  });
});
