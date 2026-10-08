import { openManualDoor, openManualDoorWithAirlock } from './openManualDoor';
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

describe('openManualDoor — cola / cloud', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    openDoorOnStation.mockReset();
  });

  test('relayMode local → un clic por API (cola), no HTTP LAN', async () => {
    apiFetch.mockResolvedValue({
      message: 'Pedido enviado a la estación',
      relay: { via: 'local-queue' }
    });
    const result = await openManualDoor({
      authToken: 'tok',
      door: localDoor
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/guard/open-door',
      expect.objectContaining({ method: 'POST' })
    );
    expect(openDoorOnStation).not.toHaveBeenCalled();
    expect(result.via).toBe('local-queue');
    expect(result.auditPath).toBe('localViaQueue');
  });

  test('forceLocal → HTTP directo a la estación', async () => {
    openDoorOnStation.mockResolvedValue({
      ok: true,
      status: 200,
      data: { message: 'ok' }
    });
    const door = {
      ...localDoor,
      device: { host: '192.168.0.38', port: 6722, channel: 1 }
    };
    const result = await openManualDoor({
      authToken: 'tok',
      door,
      forceLocal: true
    });
    expect(openDoorOnStation).toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result.via).toBe('local');
  });

  test('cloud falla por red → fallback a estación', async () => {
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

  test('forceLocal sin estación → error', async () => {
    await expect(openManualDoor({
      authToken: 'tok',
      door: { id: 'puerta-p1', relayMode: 'local' },
      forceLocal: true
    })).rejects.toThrow(/estación local/);
    expect(openDoorOnStation).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('openManualDoorWithAirlock — estanco', () => {
  const airlockErr = () => Object.assign(
    new Error('No se puede abrir: la otra puerta del estanco (Exterior) está abierta. Esperá a que se cierre.'),
    { status: 409, data: { code: 'AIRLOCK_OTHER_OPEN' } }
  );

  beforeEach(() => {
    apiFetch.mockReset();
    openDoorOnStation.mockReset();
  });

  test('sin permiso de forzar: propaga el mensaje del 409 y no cae a la estación local', async () => {
    apiFetch.mockRejectedValue(airlockErr());
    const confirmWithReason = jest.fn();
    await expect(openManualDoorWithAirlock({
      authToken: 'tok',
      door: { id: 'int', localStation: localDoor.localStation },
      canForceAirlock: false,
      confirmWithReason
    })).rejects.toThrow(/Esperá a que se cierre/);
    expect(confirmWithReason).not.toHaveBeenCalled();
    expect(openDoorOnStation).not.toHaveBeenCalled();
  });

  test('con permiso: pide motivo y reintenta con forceAirlock', async () => {
    apiFetch
      .mockRejectedValueOnce(airlockErr())
      .mockResolvedValueOnce({ message: 'ok', relay: { via: 'cloud' } });
    const confirmWithReason = jest.fn().mockResolvedValue('Evacuación');
    const result = await openManualDoorWithAirlock({
      authToken: 'tok',
      doorId: 'int',
      canForceAirlock: true,
      confirmWithReason
    });
    expect(confirmWithReason).toHaveBeenCalledWith(expect.objectContaining({
      confirmLabel: 'Forzar apertura (queda registrado)'
    }));
    expect(apiFetch).toHaveBeenLastCalledWith('/guard/open-door', expect.objectContaining({
      body: expect.objectContaining({ forceAirlock: true, forceReason: 'Evacuación', doorId: 'int' })
    }));
    expect(result.message).toBe('ok');
  });

  test('con permiso pero cancela: no reintenta', async () => {
    apiFetch.mockRejectedValueOnce(airlockErr());
    const result = await openManualDoorWithAirlock({
      authToken: 'tok',
      doorId: 'int',
      canForceAirlock: true,
      confirmWithReason: jest.fn().mockResolvedValue(null)
    });
    expect(result.cancelled).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  test('apertura normal no manda bypassAirlock', async () => {
    apiFetch.mockResolvedValue({ message: 'ok' });
    await openManualDoor({ authToken: 'tok', doorId: 'p1' });
    expect(apiFetch.mock.calls[0][1].body).toEqual({ reason: 'apertura_manual_guardia', doorId: 'p1' });
  });
});
