import { placesNeedChoice, readersForDraft, sidesFromPlaces, swapPlaces, validateSimpleDoor } from './doorForm';

describe('formulario simple de puerta', () => {
  const base = {
    id: 'porton',
    name: 'Portón de clientes',
    kind: 'gate',
    placeA: 'exterior',
    placeB: 'planta',
    pulseSeconds: 3,
    sensorsRequired: false
  };

  test('invierte afuera y adentro y arma los lectores según el lado', () => {
    expect(swapPlaces('estacionamiento', 'planta')).toEqual({ placeA: 'planta', placeB: 'estacionamiento' });
    expect(readersForDraft({ doorCode: 'P1', readersMode: 'outside' })).toEqual([
      { id: 'INGRESO_P1', direction: 'ingreso', side: 'in' }
    ]);
    expect(readersForDraft({ doorCode: 'P1', readersMode: 'both' }).map((reader) => reader.side)).toEqual(['in', 'out']);
  });

  test('un lado vacío o repetido pide elegir lugares', () => {
    expect(placesNeedChoice('', 'planta')).toBe(true);
    expect(placesNeedChoice('planta', '')).toBe(true);
    expect(placesNeedChoice('planta', 'planta')).toBe(true);
    expect(placesNeedChoice('exterior', 'planta')).toBe(false);
  });

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

});
