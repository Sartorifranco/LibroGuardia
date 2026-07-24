import {
  mergeStationStatusIntoDoors,
  cacheGuardDoors,
  loadCachedGuardDoors,
  GUARD_DOORS_CACHE_KEY
} from './localStationClient';

describe('localStationClient helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('cache / load de puertas del guardia', () => {
    cacheGuardDoors([{
      id: 'p1',
      name: 'P1',
      relayMode: 'local',
      localStation: {
        estacionId: 'e1',
        direccionRedLocal: '10.0.0.5',
        puertoServidorLocal: 8787,
        secretoLocal: 'x'
      }
    }]);
    const loaded = loadCachedGuardDoors();
    expect(loaded.doors[0].id).toBe('p1');
    expect(loaded.doors[0].localStation.secretoLocal).toBe('x');
    expect(localStorage.getItem(GUARD_DOORS_CACHE_KEY)).toBeTruthy();
  });

  test('mergeStationStatusIntoDoors marca connected/allowlist', () => {
    const doors = [{ id: 'puerta-p1', name: 'P1' }];
    const probes = [{
      ok: true,
      doorIds: ['puerta-p1'],
      readers: [{
        doorId: 'puerta-p1',
        connected: true,
        lastScanAt: '2026-07-23T12:00:00.000Z',
        allowlistFresh: true
      }]
    }];
    const merged = mergeStationStatusIntoDoors(doors, probes);
    expect(merged[0].localReachable).toBe(true);
    expect(merged[0].localReader.connected).toBe(true);
    expect(merged[0].lastPulse.at).toBe('2026-07-23T12:00:00.000Z');
  });
});
