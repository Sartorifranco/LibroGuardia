import { buildVisitaQrPayload, getVisitaWindow } from './visitaInvite';

describe('visitaInvite', () => {
  it('arma payload JSON con dni para el lector', () => {
    const raw = buildVisitaQrPayload({
      id: 'v1',
      dniVisitante: '27.762.583',
      nombreVisitante: 'Ramiro'
    });
    const parsed = JSON.parse(raw);
    expect(parsed.tipo).toBe('visita_mss');
    expect(parsed.dni).toBe('27762583');
    expect(parsed.visitaId).toBe('v1');
  });

  it('calcula ventana desde 2h antes hasta fin del día AR', () => {
    const windowInfo = getVisitaWindow('2026-07-28T14:30:00.000-03:00');
    expect(windowInfo.start).toBeInstanceOf(Date);
    expect(windowInfo.end).toBeInstanceOf(Date);
    expect(windowInfo.end.getTime()).toBeGreaterThan(windowInfo.start.getTime());
    expect(windowInfo.label).toMatch(/Válido desde/);
  });
});
