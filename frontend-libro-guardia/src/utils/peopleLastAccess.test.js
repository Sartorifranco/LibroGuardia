import {
  formatLastAccessLabel,
  matchesClientAccessFilter
} from './peopleLastAccess';

describe('peopleLastAccess helpers', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');

  test('formatea nunca / sin dato', () => {
    const label = formatLastAccessLabel({}, { now });
    expect(label.kind).toBe('unknown');
    expect(label.text).toBe('Sin dato');
  });

  test('formatea hace N días', () => {
    const label = formatLastAccessLabel({
      lastAccessAt: '2026-07-24T12:00:00.000Z',
      daysSinceAccess: 10
    }, { now });
    expect(label.text).toBe('Hace 10 días');
    expect(label.kind).toBe('ok');
  });

  test('filtra unused y never', () => {
    const never = {};
    const stale = { lastAccessAt: '2025-01-01T00:00:00.000Z', daysSinceAccess: 200 };
    const recent = { lastAccessAt: '2026-08-01T00:00:00.000Z', daysSinceAccess: 2 };

    expect(matchesClientAccessFilter(never, 'never', now)).toBe(true);
    expect(matchesClientAccessFilter(stale, 'never', now)).toBe(false);
    expect(matchesClientAccessFilter(stale, 'unused:180', now)).toBe(true);
    expect(matchesClientAccessFilter(recent, 'unused:180', now)).toBe(false);
    expect(matchesClientAccessFilter(never, 'unused:90', now)).toBe(false);
    expect(matchesClientAccessFilter(never, 'stale:90', now)).toBe(true);
  });
});
