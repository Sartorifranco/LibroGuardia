const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isRelayPulseEvent, isRelayPulseOk } = require('../lib/doorLastPulse');

describe('doorLastPulse', () => {
  it('ignora identity_verification (no es disparo de relé)', () => {
    assert.equal(isRelayPulseEvent({ type: 'identity_verification', name: 'Juan' }), false);
  });

  it('cuenta authorized con relayTriggered y manual_open', () => {
    assert.equal(isRelayPulseEvent({ type: 'authorized', relayTriggered: true }), true);
    assert.equal(isRelayPulseEvent({ type: 'authorized', relayTriggered: false }), true);
    assert.equal(isRelayPulseEvent({ type: 'manual_open' }), true);
  });

  it('modo local sin error cuenta como OK aunque relayTriggered sea false', () => {
    assert.equal(isRelayPulseOk({
      relayTriggered: false,
      relayMode: 'local'
    }), true);
  });

  it('nube OK solo si relayTriggered true', () => {
    assert.equal(isRelayPulseOk({ relayTriggered: true }), true);
    assert.equal(isRelayPulseOk({ relayTriggered: false }), false);
    assert.equal(isRelayPulseOk({ relayTriggered: false, relayError: 'timeout' }), false);
  });
});
