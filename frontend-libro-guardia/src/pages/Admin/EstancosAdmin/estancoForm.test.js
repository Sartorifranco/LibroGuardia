import {
  buildAirlockGroup,
  describeDoorAirlocks,
  joinNames,
  removeDoorFromGroups,
  syncAirlockFields,
  upsertAirlockGroup,
  validateAirlockGroup
} from './estancoForm';

const doors = [
  { id: 'guardia', name: 'Puerta Guardia' },
  { id: 'teso', name: 'Ingreso Teso y Camioneros' },
  { id: 'depo', name: 'Ingreso Depositario' },
  { id: 'playa', name: 'Portón Playa' }
];

const groups = [
  { id: 'estanco-guardia', name: 'Estanco Guardia', doorIds: ['guardia', 'teso', 'depo'], outerDoorId: 'guardia', enabled: true, mode: 'sequential_closed', transitTimeoutMs: 90000 },
  { id: 'estanco-playa', name: 'Estanco Playa', doorIds: ['playa', 'depo'], outerDoorId: 'playa', enabled: true, mode: 'sequential_closed' }
];

describe('estancos', () => {
  test('une nombres en castellano, con "e" antes de i', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A y B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B y C');
    expect(joinNames(['Ingreso Teso y Camioneros', 'Ingreso Depositario'])).toBe('Ingreso Teso y Camioneros e Ingreso Depositario');
  });

  test('describe una línea por estanco, también si la puerta está en dos', () => {
    expect(describeDoorAirlocks('guardia', groups, doors)).toEqual([
      'Estanco Guardia (con Ingreso Teso y Camioneros e Ingreso Depositario)'
    ]);
    expect(describeDoorAirlocks('depo', groups, doors)).toEqual([
      'Estanco Guardia (con Puerta Guardia e Ingreso Teso y Camioneros)',
      'Estanco Playa (con Portón Playa)'
    ]);
    expect(describeDoorAirlocks('otra', groups, doors)).toEqual([]);
  });

  test('airlockGroupId es el primer estanco y el rol sale de la puerta de afuera', () => {
    const synced = syncAirlockFields([...doors, { id: 'suelta', airlockGroupId: 'viejo', airlockRole: 'outer' }], groups);
    const byId = Object.fromEntries(synced.map((door) => [door.id, door]));
    expect(byId.guardia).toMatchObject({ airlockGroupId: 'estanco-guardia', airlockRole: 'outer' });
    expect(byId.teso).toMatchObject({ airlockGroupId: 'estanco-guardia', airlockRole: 'inner' });
    expect(byId.depo).toMatchObject({ airlockGroupId: 'estanco-guardia', airlockRole: 'inner' });
    expect(byId.playa).toMatchObject({ airlockGroupId: 'estanco-playa', airlockRole: 'outer' });
    expect(byId.suelta).toMatchObject({ airlockGroupId: null, airlockRole: null });
  });

  test('pide nombre, al menos 2 puertas y la de afuera', () => {
    const errors = validateAirlockGroup({ name: 'E', doorIds: ['guardia'], outerDoorId: '' }, groups);
    expect(errors.name).toMatch(/2 letras/);
    expect(errors.doorIds).toMatch(/al menos 2 puertas/);
    expect(errors.outerDoorId).toMatch(/de afuera/);
    expect(validateAirlockGroup({ name: 'estanco guardia', doorIds: ['teso', 'playa'], outerDoorId: 'teso' }, groups).name)
      .toMatch(/Ya hay un estanco/);
    expect(validateAirlockGroup({ name: 'Nuevo', doorIds: ['teso', 'playa'], outerDoorId: 'guardia' }, groups).outerDoorId)
      .toBeTruthy();
    expect(validateAirlockGroup({ id: 'estanco-guardia', name: 'Estanco Guardia', doorIds: ['guardia', 'teso'], outerDoorId: 'guardia' }, groups))
      .toEqual({});
  });

  test('crear un estanco de 3 puertas arma doorIds con la de afuera primero', () => {
    const group = buildAirlockGroup({ name: 'Estanco Tesoro', doorIds: ['depo', 'teso', 'playa'], outerDoorId: 'playa' }, groups, doors);
    expect(group).toEqual({
      id: 'estanco-tesoro',
      name: 'Estanco Tesoro',
      doorIds: ['playa', 'teso', 'depo'],
      outerDoorId: 'playa',
      enabled: true,
      mode: 'sequential_closed'
    });
    expect(upsertAirlockGroup(groups, group)).toHaveLength(3);
  });

  test('editar conserva id y tiempos, y no toca los demás estancos', () => {
    const group = buildAirlockGroup({ id: 'estanco-guardia', name: 'Guardia', doorIds: ['guardia', 'teso'], outerDoorId: 'teso' }, groups, doors);
    expect(group).toMatchObject({ id: 'estanco-guardia', transitTimeoutMs: 90000, doorIds: ['teso', 'guardia'], outerDoorId: 'teso' });
    const next = upsertAirlockGroup(groups, group);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(groups[1]);
  });

  test('borrar una puerta la saca y borra los estancos que quedan con una sola', () => {
    const result = removeDoorFromGroups('depo', groups);
    expect(result.removed.map((group) => group.id)).toEqual(['estanco-playa']);
    expect(result.airlockGroups).toHaveLength(1);
    expect(result.airlockGroups[0].doorIds).toEqual(['guardia', 'teso']);

    const outer = removeDoorFromGroups('guardia', groups);
    expect(outer.changedOuter.map((group) => group.id)).toEqual(['estanco-guardia']);
    expect(outer.airlockGroups[0]).toMatchObject({ doorIds: ['teso', 'depo'], outerDoorId: 'teso' });
    expect(outer.airlockGroups[1]).toBe(groups[1]);
  });
});
