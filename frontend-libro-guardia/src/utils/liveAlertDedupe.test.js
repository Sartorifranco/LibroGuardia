import { filterUnseenAlerts, markAlertSeen, wasAlertSeen } from './liveAlertDedupe';

describe('liveAlertDedupe', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('markAlertSeen evita reaparición en filterUnseenAlerts', () => {
    const alerts = [
      { id: 'a1', title: 'uno' },
      { id: 'a2', title: 'dos' }
    ];
    markAlertSeen('a1');
    expect(wasAlertSeen('a1')).toBe(true);
    expect(filterUnseenAlerts(alerts).map((a) => a.id)).toEqual(['a2']);
  });

  test('memorySeen también filtra', () => {
    const memory = new Set(['a2']);
    const alerts = [{ id: 'a1' }, { id: 'a2' }];
    expect(filterUnseenAlerts(alerts, memory).map((a) => a.id)).toEqual(['a1']);
  });
});
