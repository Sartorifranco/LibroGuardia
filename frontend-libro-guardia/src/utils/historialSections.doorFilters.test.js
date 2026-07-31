import {
  filterDoorAccessEntries,
  resolveDoorEntryOrigin
} from './historialSections';

describe('historial door filters', () => {
  test('clasifica origen biostar/kiosk', () => {
    expect(resolveDoorEntryOrigin({ entrySource: 'biostar', doorId: 'p2' })).toBe('biostar');
    expect(resolveDoorEntryOrigin({ entrySource: 'kiosk', doorId: 'p1' })).toBe('kiosk');
    expect(resolveDoorEntryOrigin({ doorId: 'p1' })).toBe('kiosk');
  });

  test('filtra por puerta y origen', () => {
    const rows = [
      { doorId: 'puerta-p1', entrySource: 'biostar', type: 'personal' },
      { doorId: 'puerta-p2', entrySource: 'kiosk', type: 'personal' },
      { doorId: 'puerta-p2', entrySource: 'biostar', type: 'personal' }
    ];
    expect(filterDoorAccessEntries(rows, { doorId: 'puerta-p2', origin: 'all' })).toHaveLength(2);
    expect(filterDoorAccessEntries(rows, { doorId: 'all', origin: 'biostar' })).toHaveLength(2);
    expect(filterDoorAccessEntries(rows, { doorId: 'puerta-p2', origin: 'biostar' })).toHaveLength(1);
  });
});
