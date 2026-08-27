const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  toBridgeRow,
  shouldAlertOffline,
  resolveHeartbeatStatus
} = require('../lib/bridgeHealthEvaluate');

describe('bridgeHealthEvaluate', () => {
  it('no alerta si nunca hubo heartbeat (instalación en curso)', () => {
    const row = toBridgeRow({
      kind: 'estacion',
      id: 'e1',
      name: 'Mini PC',
      lastAt: null,
      enabled: true
    });
    assert.equal(row.everSeen, false);
    assert.equal(row.status, 'offline');
    assert.equal(shouldAlertOffline(row, {}), false);
  });

  it('alerta al pasar a offline si ya había reportado', () => {
    const lastAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const row = toBridgeRow({
      kind: 'lector',
      id: 'l1',
      name: 'Ingreso',
      lastAt,
      enabled: true
    });
    assert.equal(resolveHeartbeatStatus(lastAt), 'offline');
    assert.equal(shouldAlertOffline(row, { lastStatus: 'online' }), true);
  });

  it('no reenvía el mail cada 5 min: espera 6 h si sigue offline', () => {
    const lastAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const row = toBridgeRow({
      kind: 'citaciones',
      id: 'citaciones-folder-bridge',
      name: 'Citados',
      lastAt,
      enabled: true
    });
    assert.equal(shouldAlertOffline(row, {
      lastStatus: 'offline',
      lastNotifiedAt: Date.now() - 10 * 60 * 1000
    }), false);
  });
});
