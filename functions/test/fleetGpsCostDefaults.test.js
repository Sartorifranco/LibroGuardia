const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Helpers re-exportados vía fleetGps (sin Firestore).
const {
  DEFAULT_FLEET_GPS
} = require('../fleetGps');

describe('fleetGps cost defaults', () => {
  it('prioriza sync cloud cada 5 min y UI cada 60s', () => {
    assert.equal(DEFAULT_FLEET_GPS.cloudSyncIntervalMinutes, 5);
    assert.equal(DEFAULT_FLEET_GPS.pollIntervalSeconds, 60);
    assert.equal(DEFAULT_FLEET_GPS.enabled, false);
  });
});
