import { argentinaYmd } from './argentinaDate';

describe('argentinaYmd', () => {
  it('a las 22 h de Argentina sigue siendo el mismo día (UTC ya es mañana)', () => {
    // 2026-10-08 22:30 en Argentina = 2026-10-09 01:30 UTC
    const d = new Date('2026-10-09T01:30:00.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-10-09');
    expect(argentinaYmd(d)).toBe('2026-10-08');
  });

  it('a la mañana coincide con UTC', () => {
    expect(argentinaYmd(new Date('2026-10-08T12:00:00.000Z'))).toBe('2026-10-08');
  });
});
