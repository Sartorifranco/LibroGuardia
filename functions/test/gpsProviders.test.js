const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  resolveProviderId,
  getGpsProvider,
  withDefaultFetchFleet,
  extractPlate,
  isGpsFleetEntry,
  gpsEntrySourceForProvider,
  joinDevicesAndPositions
} = require('../lib/gpsProviders');

describe('gpsProviders registry', () => {
  it('UBIKA es el proveedor por defecto y el único registrado', () => {
    assert.equal(DEFAULT_PROVIDER, 'ubika');
    assert.deepEqual([...PROVIDER_IDS], ['ubika']);
    assert.equal(resolveProviderId(undefined), 'ubika');
    assert.equal(resolveProviderId('no-existe'), 'ubika');
    assert.equal(getGpsProvider().id, 'ubika');
  });

  it('joinDevicesAndPositions arma el payload que usa geocercas/tránsito', () => {
    const vehicles = joinDevicesAndPositions(
      [{ id: 9, uniqueId: 'u9', name: 'Camión 1 - AF973GW', status: 'online' }],
      [{
        deviceId: 9,
        valid: true,
        latitude: -31.4,
        longitude: -64.2,
        speed: 12,
        fixTime: '2026-08-01T12:00:00.000Z',
        attributes: { ignition: true, motion: true }
      }]
    );
    assert.equal(vehicles.length, 1);
    assert.equal(vehicles[0].plate, 'AF973GW');
    assert.equal(vehicles[0].lat, -31.4);
    assert.equal(vehicles[0].lng, -64.2);
    assert.equal(vehicles[0].motion, true);
    assert.equal(extractPlate(vehicles[0].name), 'AF973GW');
  });

  it('se puede agregar un proveedor nuevo sin tocar fleetGps', async () => {
    const provider = withDefaultFetchFleet({
      id: 'fake_test_provider',
      displayName: 'Fake GPS',
      isConfigured: () => true,
      missingConfigMessage: 'falta token fake',
      fetchDevices: async () => [
        { id: 1, uniqueId: 'f1', name: 'Unidad TEST AB123CD', status: 'online' }
      ],
      fetchPositions: async () => [
        {
          deviceId: 1,
          valid: true,
          latitude: -31.41,
          longitude: -64.18,
          speed: 3,
          fixTime: '2026-08-01T10:00:00.000Z',
          attributes: { ignition: false, motion: true }
        }
      ]
    });

    const fleet = await provider.fetchFleet({});
    assert.equal(fleet.length, 1);
    assert.equal(fleet[0].plate, 'AB123CD');
    assert.equal(fleet[0].lat, -31.41);
    assert.equal(gpsEntrySourceForProvider(provider.id), 'gps_fake_test_provider');
  });
});

describe('UBIKA fetchDevices / fetchPositions', () => {
  it('consulta /api/devices y /api/positions con Bearer', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async (url) => {
      calls.push(url);
      if (String(url).endsWith('/api/devices')) {
        return {
          ok: true,
          json: async () => [{ id: 2, uniqueId: 'dev-2', name: 'HILUX AF174HL', status: 'online' }]
        };
      }
      return {
        ok: true,
        json: async () => [{
          deviceId: 2,
          valid: true,
          latitude: -31.5,
          longitude: -64.3,
          speed: 8,
          fixTime: '2026-08-01T11:00:00.000Z',
          attributes: { ignition: true, motion: true }
        }]
      };
    });

    try {
      const ubika = getGpsProvider('ubika');
      const fleet = await ubika.fetchFleet({
        apiUrl: 'https://ubika.example',
        apiKey: 'token-secreto'
      });
      assert.equal(calls.length, 2);
      assert.ok(calls.some((url) => url === 'https://ubika.example/api/devices'));
      assert.ok(calls.some((url) => url === 'https://ubika.example/api/positions'));
      assert.equal(fleet[0].name, 'HILUX AF174HL');
      assert.equal(fleet[0].plate, 'AF174HL');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('isGpsFleetEntry', () => {
  it('acepta gps_ubika, gpsAuto y cualquier gps_*', () => {
    assert.equal(gpsEntrySourceForProvider('ubika'), 'gps_ubika');
    assert.equal(gpsEntrySourceForProvider('UBIKA'), 'gps_ubika');
    assert.equal(isGpsFleetEntry({ gpsAuto: true }), true);
    assert.equal(isGpsFleetEntry({ entrySource: 'gps_ubika' }), true);
    assert.equal(isGpsFleetEntry({ entrySource: 'gps_otro' }), true);
    assert.equal(isGpsFleetEntry({ entrySource: 'manual' }), false);
    assert.equal(isGpsFleetEntry({}), false);
  });
});
