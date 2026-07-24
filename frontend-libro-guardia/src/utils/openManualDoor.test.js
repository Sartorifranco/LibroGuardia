import { openManualDoor } from './openManualDoor';
import { openDoorOnStation } from './localStationClient';
import { apiFetch } from '../services/api';

jest.mock('../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('./localStationClient', () => ({
  openDoorOnStation: jest.fn()
}));

const localDoor = {
  id: 'puerta-p1',
  relayMode: 'local',
  localStation: {
    estacionId: 'est-1',
    direccionRedLocal: '192.168.1.50',
    puertoServidorLocal: 8787,
    secretoLocal: 'sec'
  }
};

describe('openManualDoor — local / cloud', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    openDoorOnStation.mockReset();
  });

  test('relayMode local → abre por estación LAN (PASO 6)', async () => {
    openDoorOnStation.mockResolvedValue({
      ok: true,
      status: 200,
      data: { message: 'Relé local disparado' }
    });
    const result = await openManualDoor({
      authToken: 'tok',
      door: localDoor
    });
    expect(openDoorOnStation).toHaveBeenCalledWith(localDoor.localStation, 'puerta-p1');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result.via).toBe('local');
  });

  test('cloud falla por red → fallback a estación (PASO 5)', async () => {
    apiFetch.mockRejectedValue(new Error('Failed to fetch'));
    openDoorOnStation.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true }
    });
    const door = {
      id: 'puerta-p1',
      relayMode: 'cloud',
      localStation: localDoor.localStation
    };
    const result = await openManualDoor({ authToken: 'tok', door });
    expect(apiFetch).toHaveBeenCalled();
    expect(openDoorOnStation).toHaveBeenCalled();
    expect(result.via).toBe('local');
  });

  test('sin estación sigue yendo a la nube', async () => {
    apiFetch.mockResolvedValue({ message: 'ok' });
    const result = await openManualDoor({
      authToken: 'tok',
      doorId: 'puerta-p2',
      door: { id: 'puerta-p2', relayMode: 'cloud' }
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/guard/open-door',
      expect.objectContaining({ method: 'POST' })
    );
    expect(openDoorOnStation).not.toHaveBeenCalled();
    expect(result.via).toBe('cloud');
  });

  test('relayMode local SIN localStation → nube (no inventa estación)', async () => {
    apiFetch.mockResolvedValue({ message: 'ok', relay: { via: 'bridge' } });
    const result = await openManualDoor({
      authToken: 'tok',
      door: { id: 'puerta-p1', relayMode: 'local', localStation: null }
    });
    expect(openDoorOnStation).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalled();
    expect(result.via).toBe('cloud');
    expect(result.auditPath).toBe('cloudOnly_localModeWithoutStation');
  });

  test('forceLocal sin estación → error (no abre por magia)', async () => {
    await expect(openManualDoor({
      authToken: 'tok',
      door: { id: 'puerta-p1', relayMode: 'local' },
      forceLocal: true
    })).rejects.toThrow(/estación local/);
    expect(openDoorOnStation).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
