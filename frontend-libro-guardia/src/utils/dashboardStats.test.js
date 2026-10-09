import { getDashboardStats } from './dashboardStats';

describe('contadores del día', () => {
  test('la lectura repetida no suma un ingreso', () => {
    const day = '2026-10-09T15:00:00.000Z';
    const stats = getDashboardStats([
      {
        type: 'personal',
        movementType: 'ingreso',
        accessReason: 'puerta_directa',
        timestamp: day,
        name: 'Ana'
      },
      {
        type: 'personal',
        movementType: 'ingreso',
        accessReason: 'lectura_repetida',
        countsAsPassage: false,
        timestamp: '2026-10-09T15:00:06.000Z',
        name: 'Ana'
      }
    ], new Date('2026-10-09T18:00:00.000Z'));
    expect(stats.personalIngresos).toBe(1);
    expect(stats.totalToday).toBe(1);
  });
});
