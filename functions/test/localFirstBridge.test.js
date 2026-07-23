const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const bridgePath = path.join(__dirname, '..', '..', 'scripts', 'door-reader-bridge.js');
const {
  canDecideLocalFirst,
  isAllowlistFresh,
  resolveScanPath
} = require(bridgePath);

describe('door-reader-bridge localFirstMode', () => {
  const freshAllowlist = {
    generatedAt: new Date().toISOString(),
    entries: [{ dniNormalized: '43926145', nombre: 'Test' }]
  };

  const staleAllowlist = {
    generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    entries: []
  };

  it('localFirst + caché vigente → path local-first (sin kiosk-scan)', () => {
    const cfg = {
      offlineCache: true,
      localFirstMode: true,
      offlineCacheMaxAgeHours: 24
    };
    assert.equal(canDecideLocalFirst(cfg, freshAllowlist), true);
    assert.equal(resolveScanPath({ cfg, allowlist: freshAllowlist }), 'local-first');
  });

  it('localFirst con caché vencida cae al camino normal (online)', () => {
    const cfg = {
      offlineCache: true,
      localFirstMode: true,
      offlineCacheMaxAgeHours: 24
    };
    assert.equal(isAllowlistFresh(staleAllowlist, 24), false);
    assert.equal(canDecideLocalFirst(cfg, staleAllowlist), false);
    assert.equal(resolveScanPath({ cfg, allowlist: staleAllowlist }), 'online-with-offline-fallback');
  });

  it('sin localFirstMode no usa path local-first aunque haya caché', () => {
    const cfg = {
      offlineCache: true,
      localFirstMode: false,
      offlineCacheMaxAgeHours: 24
    };
    assert.equal(canDecideLocalFirst(cfg, freshAllowlist), false);
    assert.equal(resolveScanPath({ cfg, allowlist: freshAllowlist }), 'online-with-offline-fallback');
  });

  it('puerta sin offlineCache se comporta online-only (igual que hoy)', () => {
    const cfg = {
      offlineCache: false,
      localFirstMode: true, // ignorado sin offlineCache
      offlineCacheMaxAgeHours: 24
    };
    assert.equal(canDecideLocalFirst(cfg, freshAllowlist), false);
    assert.equal(resolveScanPath({ cfg, allowlist: freshAllowlist }), 'online-only');
  });

  it('simula decisión: kioskScan no se invoca en local-first', async () => {
    let kioskCalls = 0;
    const kioskScan = async () => {
      kioskCalls += 1;
      return { status: 200, data: { authorized: true } };
    };

    const cfg = {
      offlineCache: true,
      localFirstMode: true,
      offlineCacheMaxAgeHours: 24
    };
    const pathName = resolveScanPath({ cfg, allowlist: freshAllowlist });
    assert.equal(pathName, 'local-first');
    if (pathName !== 'local-first') {
      await kioskScan();
    }
    assert.equal(kioskCalls, 0);
  });
});
