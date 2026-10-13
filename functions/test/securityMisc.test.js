const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { setupHarness } = require('./helpers/routeHarness');

describe('secretMask', () => {
  setupHarness();
  const {
    maskSecret,
    resolveIncomingSecret,
    restoreDoorSecrets
  } = require('../lib/secretMask');

  it('enmascara con 2 últimos caracteres y no revela secretos cortos', () => {
    assert.equal(maskSecret(''), '');
    assert.equal(maskSecret(null), '');
    assert.equal(maskSecret('abc'), '••••');
    assert.equal(maskSecret('abcdefgh12'), '••••12');
  });

  it('máscara o vacío conserva el existente; valor nuevo reemplaza', () => {
    assert.equal(resolveIncomingSecret('••••12', 'viejo'), 'viejo');
    assert.equal(resolveIncomingSecret('', 'viejo'), 'viejo');
    assert.equal(resolveIncomingSecret('nuevo', 'viejo'), 'nuevo');
    assert.equal(resolveIncomingSecret(undefined, 'viejo'), undefined);
  });

  it('restoreDoorSecrets empareja por id normalizado y conserva secreto si el campo no viene', () => {
    const out = restoreDoorSecrets(
      [{ id: 'Puerta 1', device: { httpAuthToken: '••••zz' } }],
      [{ id: 'puerta-1', device: { bridgeSecret: 'S1-larguisimo', httpAuthToken: 'T1-larguisimo' } }]
    );
    assert.equal(out[0].device.bridgeSecret, 'S1-larguisimo');
    assert.equal(out[0].device.httpAuthToken, 'T1-larguisimo');
  });
});

describe('citacionesBridge', () => {
  setupHarness();
  const { safeEqualSecret, publicCitacionesBridgeHealth } = require('../citacionesBridge');

  it('safeEqualSecret compara en tiempo constante y rechaza vacíos', () => {
    assert.equal(safeEqualSecret('secreto', 'secreto'), true);
    assert.equal(safeEqualSecret('secreto', 'secretO'), false);
    assert.equal(safeEqualSecret('corto', 'mucho-mas-largo'), false);
    assert.equal(safeEqualSecret('', ''), false);
    assert.equal(safeEqualSecret(undefined, 'x'), false);
  });

  it('health público no expone lastSyncError ni archivos', () => {
    const body = publicCitacionesBridgeHealth({
      enabled: true,
      lastSyncAt: '2026-10-07T10:00:00.000Z',
      lastHeartbeatAt: '2026-10-07T10:01:00.000Z',
      lastSyncFile: 'C:\\usr\\citados.xlsx',
      lastSyncCount: 10,
      lastSyncError: 'ENOENT C:\\usr\\secreto',
      bridgeSecret: 'no-debe-salir'
    });
    const text = JSON.stringify(body);
    assert.equal(body.status, 'ok');
    assert.equal(body.lastSyncAt, '2026-10-07T10:00:00.000Z');
    assert.equal(body.hasSyncError, true);
    assert.equal(text.includes('ENOENT'), false);
    assert.equal(text.includes('citados.xlsx'), false);
    assert.equal(text.includes('no-debe-salir'), false);
  });
});

describe('lectorPairing', () => {
  setupHarness();
  const { generateSixDigitCode } = require('../lib/lectorPairing');

  it('genera siempre 6 dígitos', () => {
    for (let i = 0; i < 500; i += 1) {
      assert.match(generateSixDigitCode(), /^\d{6}$/);
    }
  });
});
