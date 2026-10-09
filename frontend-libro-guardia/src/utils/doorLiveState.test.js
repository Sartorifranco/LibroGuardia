import { applyDoorLiveEvent, doorLivePresentation } from './doorLiveState';

describe('estado de puerta para el guardia', () => {
  test('DESBLOQUEADA es Destrabada en azul y ABIERTA_AUT es Abierta', () => {
    expect(doorLivePresentation({ live: { state: 'SEGURA' } })).toMatchObject({ label: 'Cerrada', tone: 'ok' });
    expect(doorLivePresentation({ live: { state: 'DESBLOQUEADA' } })).toMatchObject({ label: 'Destrabada', tone: 'open' });
    expect(doorLivePresentation({ live: { state: 'ABIERTA_AUT' } })).toMatchObject({ label: 'Abierta', tone: 'open' });
    expect(doorLivePresentation({ live: { state: 'RETENIDA' } }).label).toBe('Abierta demasiado tiempo');
  });

  test('el evento SSE plano actualiza live.state', () => {
    const next = applyDoorLiveEvent(
      [{ id: 'p1', name: 'Exterior', live: { state: 'SEGURA', dps: 'closed' } }],
      { doorId: 'p1', state: 'DESBLOQUEADA', dps: 'closed', bond: 'engaged', since: 50 }
    );
    expect(next[0].live).toEqual({ state: 'DESBLOQUEADA', dps: 'closed', bond: 'engaged', since: 50 });
    expect(next[0].name).toBe('Exterior');
  });
});
