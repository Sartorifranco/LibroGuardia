const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDriverId,
  getDoorDriver,
  triggerRelay,
  DEFAULT_DRIVER
} = require('../lib/doorDrivers');
const { normalizeDoorsConfig } = require('../lib/doorsConfig');

describe('doorDrivers registry', () => {
  it('puerta sin driver definido resuelve a sr201', () => {
    assert.equal(resolveDriverId(undefined), 'sr201');
    assert.equal(resolveDriverId(null), 'sr201');
    assert.equal(resolveDriverId(''), DEFAULT_DRIVER);
    assert.equal(getDoorDriver(undefined).id, 'sr201');

    const config = normalizeDoorsConfig({
      doors: [{ id: 'p1', name: 'Principal', device: { host: '10.0.0.1' } }]
    });
    assert.equal(config.doors[0].device.driver, 'sr201');
  });

  it('driver desconocido cae a sr201', () => {
    assert.equal(resolveDriverId('modbus_tcp'), 'sr201');
    const config = normalizeDoorsConfig({
      doors: [{ id: 'p2', name: 'X', device: { driver: 'no-existe' } }]
    });
    assert.equal(config.doors[0].device.driver, 'sr201');
  });

  it('generic_http resuelve al driver nuevo y arma el request HTTP esperado', async () => {
    assert.equal(getDoorDriver('generic_http').id, 'generic_http');

    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      };
    });

    try {
      const result = await triggerRelay({
        driver: 'generic_http',
        enabled: true,
        httpUrl: 'https://relay.example/open',
        httpMethod: 'POST',
        httpAuthToken: 'secret-token',
        pulseMode: 'timed',
        pulseSeconds: 5
      });

      assert.equal(result.triggered, true);
      assert.equal(result.via, 'generic_http');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://relay.example/open');
      assert.equal(calls[0].options.method, 'POST');
      assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
      assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
      assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'pulse', seconds: 5 });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('generic_http con pulseMode jog envía action open', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      };
    });

    try {
      await triggerRelay({
        driver: 'generic_http',
        httpUrl: 'https://relay.example/open',
        pulseMode: 'jog',
        pulseSeconds: 3
      });
      assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'open', seconds: 3 });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
