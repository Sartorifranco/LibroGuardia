const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPulseCommand, triggerRelay } = require('../sr201');

describe('sr201', () => {
  it('buildPulseCommand genera jog y timed para canal 1 y 2', () => {
    assert.equal(buildPulseCommand(1, 'jog'), '11*');
    assert.equal(buildPulseCommand(2, 'jog'), '12*');
    assert.equal(buildPulseCommand(1, 'timed', 3), '11:03');
    assert.equal(buildPulseCommand(1, 'timed', 15), '11:15');
  });

  it('triggerRelay omite si enabled=false', async () => {
    const skipped = await triggerRelay({ enabled: false });
    assert.equal(skipped.triggered, false);
    assert.equal(skipped.skipped, true);
  });
});
