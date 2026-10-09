import { applyAirlockChoice, sidesFromPlaces, validateSimpleDoor } from './doorForm';

describe('formulario simple de puerta', () => {
  const base = {
    id: 'porton',
    name: 'Portón de clientes',
    kind: 'gate',
    placeA: 'exterior',
    placeB: 'planta',
    pulseSeconds: 3,
    sensorsRequired: false,
    airlockEnabled: false
  };

  test('acepta una puerta con dos lugares distintos', () => {
    expect(validateSimpleDoor(base)).toEqual({});
    expect(sidesFromPlaces('exterior', 'planta')).toEqual({
      in: { zoneFrom: 'exterior', zoneTo: 'planta' },
      out: { zoneFrom: 'planta', zoneTo: 'exterior' }
    });
  });

  test('explica cómo corregir nombre, lugares, segundos y sensor', () => {
    const errors = validateSimpleDoor({
      ...base,
      name: 'A',
      placeA: 'planta',
      placeB: 'planta',
      pulseSeconds: 0,
      sensorsRequired: true,
      heldOpenSec: 3
    });
    expect(errors.name).toMatch(/2 letras/);
    expect(errors.placeB).toMatch(/distintos/);
    expect(errors.pulseSeconds).toMatch(/1 y 60/);
    expect(errors.heldOpenSec).toMatch(/10 y 600|más largo/);
  });

  test('el estanco pide otra puerta y no acepta la misma', () => {
    expect(validateSimpleDoor({ ...base, airlockEnabled: true, airlockPartnerId: '' }).airlockPartnerId)
      .toMatch(/otra puerta/);
    expect(validateSimpleDoor({ ...base, airlockEnabled: true, airlockPartnerId: 'porton' }).airlockPartnerId)
      .toMatch(/consigo misma/);
  });

  test('arma el estanco con la pareja y suelta la anterior', () => {
    const doors = [
      { id: 'porton', name: 'Portón', airlockGroupId: 'viejo', airlockRole: 'outer' },
      { id: 'molinete', name: 'Molinete', airlockGroupId: 'viejo', airlockRole: 'inner' },
      { id: 'oficina', name: 'Oficina' }
    ];
    const groups = [{ id: 'viejo', doorIds: ['porton', 'molinete'], enabled: true }];
    const paired = applyAirlockChoice(doors, groups, {
      ...base,
      airlockEnabled: true,
      airlockPartnerId: 'oficina'
    });
    expect(paired.airlockGroups).toHaveLength(1);
    expect(paired.airlockGroups[0].doorIds.slice().sort()).toEqual(['oficina', 'porton']);
    const porton = paired.doors.find((door) => door.id === 'porton');
    const oficina = paired.doors.find((door) => door.id === 'oficina');
    const molinete = paired.doors.find((door) => door.id === 'molinete');
    expect(porton.airlockRole).toBe('outer');
    expect(oficina.airlockRole).toBe('inner');
    expect(molinete.airlockGroupId).toBeNull();
  });

  test('desmarcar el estanco desarma la pareja', () => {
    const doors = [
      { id: 'porton', airlockGroupId: 'estanco-oficina-porton', airlockRole: 'outer' },
      { id: 'oficina', airlockGroupId: 'estanco-oficina-porton', airlockRole: 'inner' }
    ];
    const groups = [{ id: 'estanco-oficina-porton', doorIds: ['porton', 'oficina'], enabled: true }];
    const paired = applyAirlockChoice(doors, groups, { ...base, airlockEnabled: false });
    expect(paired.airlockGroups).toHaveLength(0);
    expect(paired.doors.every((door) => door.airlockGroupId == null)).toBe(true);
  });
});
