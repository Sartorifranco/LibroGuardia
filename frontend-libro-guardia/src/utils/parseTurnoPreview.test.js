import { parseTurnoPreview } from './parseTurnoPreview';

describe('parseTurnoPreview', () => {
  it('interpreta días y horario estándar', () => {
    const parsed = parseTurnoPreview('Lu,Ma,Mi,Ju,Vi 07:30 a 16:00');
    expect(parsed.valid).toBe(true);
    expect(parsed.daysOfWeek).toEqual(['Lu', 'Ma', 'Mi', 'Ju', 'Vi']);
    expect(parsed.timeWindow).toEqual({ from: '07:30', to: '16:00' });
  });

  it('falla con texto libre sin patrón', () => {
    const parsed = parseTurnoPreview('turno mañana administración');
    expect(parsed.valid).toBe(false);
  });
});
