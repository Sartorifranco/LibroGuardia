const { describe, it } = require('node:test');
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
});
