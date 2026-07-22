const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { buildPulseCommand, triggerRelay, parseRelayStatusBits } = require('../sr201');

describe('sr201', () => {
  it('buildPulseCommand genera jog y timed para canal 1 y 2', () => {
    assert.equal(buildPulseCommand(1, 'jog'), '11*');
    assert.equal(buildPulseCommand(2, 'jog'), '12*');
    assert.equal(buildPulseCommand(1, 'timed', 3), '11:3');
    assert.equal(buildPulseCommand(1, 'timed', 15), '11:15');
  });

  it('triggerRelay omite si enabled=false', async () => {
    const skipped = await triggerRelay({ enabled: false });
    assert.equal(skipped.triggered, false);
    assert.equal(skipped.skipped, true);
  });

  it('sin bridgeUrl y host LAN exige URL del puente (no intenta TCP desde cloud)', async () => {
    await assert.rejects(
      () => triggerRelay({ enabled: true, host: '192.168.0.38', port: 6722, relayChannel: 1 }),
      /URL pública del puente SR201/
    );
  });

  it('parseRelayStatusBits interpreta bits de canal', () => {
    const parsed = parseRelayStatusBits('10000000');
    assert.equal(parsed.channels[1], true);
    assert.equal(parsed.channels[2], false);
  });

  it('triggerRelay timed vía bridge resuelve al aceptar /pulse (sin esperar pulseSeconds)', async () => {
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = mock.fn(async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: 'Pulso temporizado 15s iniciado (OFF async)',
          async: true,
          mode: 'timed',
          seconds: 15,
          command: '11 / wait 15s / 21'
        })
      };
    });

    try {
      const t0 = Date.now();
      const result = await triggerRelay({
        enabled: true,
        host: '192.168.0.38',
        port: 6722,
        relayChannel: 1,
        pulseMode: 'timed',
        pulseSeconds: 15,
        bridgeUrl: 'https://bridge.example',
        bridgeSecret: 'secret'
      });
      const elapsed = Date.now() - t0;
      assert.equal(result.triggered, true);
      assert.equal(result.via, 'bridge');
      assert.equal(fetchCalls, 1);
      assert.ok(elapsed < 2000, `esperaba respuesta rápida, tardó ${elapsed}ms`);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
