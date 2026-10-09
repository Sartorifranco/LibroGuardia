const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCountingFirestore } = require('./helpers/countingFirestore');
const {
  fetchNearbyFleetAlerts,
  invalidateFleetLookupCache,
  warmFleetLookupCache
} = require('../fleetGps');

const GUARDIA = { lat: -34.6037, lng: -58.3816 };

const baseConfig = {
  enabled: true,
  provider: 'ubika',
  apiKey: 'token-test',
  apiUrl: 'https://ubika.example',
  guardiaLat: GUARDIA.lat,
  guardiaLng: GUARDIA.lng,
  geofenceMode: 'circle',
  gateRadiusMeters: 45,
  plantRadiusMeters: 400,
  minSpeedKnots: 1,
  requireMotion: true,
  autoRegisterMovements: true,
  movementCooldownSeconds: 300,
  cloudSyncIntervalMinutes: 5,
  approachAlertEnabled: false,
  lastError: null,
  lastSyncAt: null
};

const vehicle = (overrides = {}) => ({
  deviceId: 'dev-1',
  name: 'Camion 1',
  plate: 'AA123BB',
  status: 'online',
  ignition: false,
  motion: false,
  speed: 0,
  lat: GUARDIA.lat + 0.01,
  lng: GUARDIA.lng,
  ...overrides
});

const poll = (db, FieldValue, vehicles) => fetchNearbyFleetAlerts(db, FieldValue, {
  forceUbika: true,
  preferCache: false,
  userId: 'sistema_gps',
  username: 'GPS automático',
  vehicles
});

describe('fleetGps costo por vuelta', () => {
  beforeEach(() => invalidateFleetLookupCache());
  afterEach(() => invalidateFleetLookupCache());

  it('vuelta sin cambios: como máximo 3 lecturas y 0 escrituras', async () => {
    const store = createCountingFirestore({
      'settings/fleetGps': baseConfig
    });
    const parked = [vehicle()];
    await poll(store.db, store.FieldValue, parked);
    await warmFleetLookupCache(store.db);
    store.resetStats();

    await poll(store.db, store.FieldValue, parked);

    assert.ok(
      store.stats.reads <= 3,
      `lecturas ${store.stats.reads}: ${store.stats.log.join(' | ')}`
    );
    assert.equal(store.stats.writes, 0, store.stats.log.join(' | '));
  });

  it('un vehículo que cruza: como máximo 4 lecturas y 3 escrituras', async () => {
    const store = createCountingFirestore({
      'settings/fleetGps': baseConfig
    });
    await poll(store.db, store.FieldValue, [vehicle()]);
    await warmFleetLookupCache(store.db);
    store.resetStats();

    const result = await poll(store.db, store.FieldValue, [vehicle({
      lat: GUARDIA.lat + 0.002,
      motion: true,
      speed: 8,
      ignition: true
    })]);

    assert.equal(result.registered.length, 1);
    assert.equal(result.registered[0].direction, 'ingreso');
    assert.ok(
      store.stats.reads <= 4,
      `lecturas ${store.stats.reads}: ${store.stats.log.join(' | ')}`
    );
    assert.ok(
      store.stats.writes <= 3,
      `escrituras ${store.stats.writes}: ${store.stats.log.join(' | ')}`
    );
    assert.ok(store.stats.writes >= 1);
  });
});
