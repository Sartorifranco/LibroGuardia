import {
  formatDoorAccessPhrase,
  isDoorAccessEntry,
  isManualPersonalEntry,
  resolveDoorName
} from './historialSections';

describe('historialSections', () => {
  test('distingue acceso por puerta vs personal manual', () => {
    expect(isDoorAccessEntry({ type: 'personal', doorId: 'p1', entrySource: 'kiosk' })).toBe(true);
    expect(isDoorAccessEntry({ type: 'personal', entrySource: 'kiosk' })).toBe(true);
    expect(isDoorAccessEntry({ type: 'personal', entrySource: 'manual' })).toBe(false);
    expect(isManualPersonalEntry({ type: 'personal', entrySource: 'manual' })).toBe(true);
    expect(isManualPersonalEntry({ type: 'personal', doorId: 'x' })).toBe(false);
    expect(isDoorAccessEntry({ type: 'vehiculo', doorId: 'x' })).toBe(false);
  });

  test('resolveDoorName prioriza doorName y luego el mapa', () => {
    expect(resolveDoorName({ doorName: 'Molinete A', doorId: 'id1' }, { id1: 'Otro' })).toBe('Molinete A');
    expect(resolveDoorName({ doorId: 'id1' }, { id1: 'Portón Norte' })).toBe('Portón Norte');
    expect(resolveDoorName({ doorId: 'id-huérfano' }, {})).toBe('id-huérfano');
    expect(resolveDoorName({})).toBe('Sin puerta');
  });

  test('formatDoorAccessPhrase arma lenguaje de puerta', () => {
    const r = formatDoorAccessPhrase(
      { name: 'Ana Pérez', movementType: 'ingreso', doorId: 'd1' },
      { d1: 'Acceso principal' }
    );
    expect(r.verb).toBe('ingresó');
    expect(r.door).toBe('Acceso principal');
    expect(r.phrase).toBe('Ana Pérez ingresó por Acceso principal');
  });
});
