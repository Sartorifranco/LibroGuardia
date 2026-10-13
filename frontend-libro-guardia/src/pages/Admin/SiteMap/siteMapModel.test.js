import { buildSiteMap, buildSiteTree, layoutSiteMap } from './siteMapModel';

const both = [{ side: 'in' }, { side: 'out' }];
const door = (id, name, from, to, extra = {}) => ({
  id,
  name,
  kind: 'door',
  active: true,
  readers: both,
  sides: { in: { zoneFrom: from, zoneTo: to }, out: { zoneFrom: to, zoneTo: from } },
  ...extra
});

function examplePredio() {
  return {
    areas: [
      { id: 'exterior', name: 'Exterior', fixed: true },
      { id: 'estacionamiento', name: 'Estacionamiento' },
      { id: 'planta', name: 'Planta' },
      { id: 'esclusa', name: 'Esclusa' },
      { id: 'tesoreria', name: 'Tesorería' },
      { id: 'boveda', name: 'Bóveda' }
    ],
    doors: [
      door('porton', 'Portón principal', 'exterior', 'estacionamiento', { kind: 'gate' }),
      door('p-planta', 'Puerta planta', 'estacionamiento', 'planta'),
      door('e1', 'Estanco entrada', 'planta', 'esclusa'),
      door('e2', 'Estanco tesorería', 'esclusa', 'tesoreria'),
      door('e3', 'Estanco bóveda', 'esclusa', 'boveda')
    ],
    airlockGroups: [{ id: 'g1', name: 'Estanco tesoro', doorIds: ['e1', 'e2', 'e3'], outerDoorId: 'e1' }]
  };
}

const types = (model) => model.problems.map((p) => p.type);

describe('buildSiteMap', () => {
  test('predio de ejemplo: niveles, estanco y sin problemas', () => {
    const model = buildSiteMap(examplePredio());
    expect(model.problems).toEqual([]);
    expect(model.nodes).toHaveLength(6);
    expect(model.edges).toHaveLength(5);
    const level = Object.fromEntries(model.nodes.map((n) => [n.id, n.level]));
    expect(level).toEqual({ exterior: 0, estacionamiento: 1, planta: 2, esclusa: 3, tesoreria: 4, boveda: 4 });
    expect(model.nodes.filter((n) => n.airlock).map((n) => n.id)).toEqual(['esclusa']);
    expect(model.edges.find((e) => e.id === 'porton').kind).toBe('gate');
    const nivel4 = model.nodes.filter((n) => n.level === 4).map((n) => [n.name, n.order]);
    expect(nivel4).toEqual([['Bóveda', 0], ['Tesorería', 1]]);
  });

  test('agrega Exterior si la lista de lugares no lo trae', () => {
    const data = examplePredio();
    data.areas = data.areas.filter((a) => a.id !== 'exterior');
    const model = buildSiteMap(data);
    expect(model.nodes[0]).toMatchObject({ id: 'exterior', name: 'Exterior', level: 0 });
    expect(model.problems).toEqual([]);
  });

  test('puerta sin los dos lugares o con el mismo lugar', () => {
    const data = examplePredio();
    data.doors.push(door('vacia', 'Sin lugares', 'planta', ''));
    data.doors.push(door('igual', 'Repetida', 'planta', 'planta'));
    const model = buildSiteMap(data);
    expect(types(model)).toEqual(['door_sides', 'door_same_place']);
    expect(model.problems[0]).toMatchObject({ target: 'puertas', refId: 'vacia' });
    expect(model.problems[0].message).toMatch(/no dice qué dos lugares une/);
    expect(model.problems[1].message).toMatch(/mismo lugar de los dos lados/);
    expect(model.edges).toHaveLength(5);
  });

  test('puerta que usa un lugar borrado', () => {
    const data = examplePredio();
    data.doors.push(door('rara', 'Rara', 'planta', 'fantasma'));
    expect(types(buildSiteMap(data))).toEqual(['door_missing_place']);
  });

  test('lugar sin puertas y lugar al que no se llega desde Exterior', () => {
    const data = examplePredio();
    data.areas.push({ id: 'deposito', name: 'Depósito' }, { id: 'taller', name: 'Taller' }, { id: 'patio', name: 'Patio' });
    data.doors.push(door('t1', 'Taller patio', 'taller', 'patio'));
    const model = buildSiteMap(data);
    expect(types(model)).toEqual(['place_no_doors', 'place_unreachable', 'place_unreachable']);
    expect(model.problems[0].message).toBe('El lugar “Depósito” no tiene ninguna puerta.');
    expect(model.problems[1].message).toMatch(/No se puede llegar a “Taller” desde Exterior/);
    expect(model.hasUnreachable).toBe(true);
    const taller = model.nodes.find((n) => n.id === 'taller');
    expect(taller.reachable).toBe(false);
    expect(taller.level).toBe(5);
  });

  test('dos lugares con el mismo nombre', () => {
    const data = examplePredio();
    data.areas.push({ id: 'planta2', name: ' planta ' });
    data.doors.push(door('p2', 'Otra planta', 'estacionamiento', 'planta2'));
    const model = buildSiteMap(data);
    expect(types(model)).toEqual(['duplicate_place_name']);
    expect(model.problems[0]).toMatchObject({ target: 'lugares' });
    expect(model.problems[0].message).toMatch(/Hay 2 lugares que se llaman “Planta”/);
  });

  test('lector de un solo lado', () => {
    const data = examplePredio();
    data.doors[1].readers = [{ side: 'in' }];
    data.doors[0].readers = [{ direction: 'egreso' }];
    data.doors.push(door('apagada', 'Apagada', 'planta', 'estacionamiento', { active: false, readers: [{ side: 'in' }] }));
    const model = buildSiteMap(data);
    expect(types(model)).toEqual(['reader_one_side', 'reader_one_side']);
    expect(model.problems[0].message).toMatch(/registra quién sale pero no quién entra/);
    expect(model.problems[1].message).toMatch(/Registra quién entra pero no quién sale/i);
  });

  test('estanco con una sola puerta o con puertas que no tocan un mismo lugar', () => {
    const data = examplePredio();
    data.airlockGroups.push({ id: 'g2', name: 'Solito', doorIds: ['p-planta'], outerDoorId: 'p-planta' });
    data.airlockGroups.push({ id: 'g3', name: 'Separado', doorIds: ['porton', 'e2'], outerDoorId: 'porton' });
    const model = buildSiteMap(data);
    expect(types(model)).toEqual(['airlock_single_door', 'airlock_no_common_place']);
    expect(model.problems[0].message).toMatch(/“Solito” tiene una sola puerta/);
    expect(model.problems[1].message).toMatch(/“Separado” no dan a un mismo lugar/);
  });
});

describe('layoutSiteMap y buildSiteTree', () => {
  test('columnas de izquierda a derecha y etiqueta en el medio de la línea', () => {
    const model = buildSiteMap(examplePredio());
    const layout = layoutSiteMap(model);
    const x = (id) => layout.positions.get(id).x;
    expect(x('exterior')).toBeLessThan(x('estacionamiento'));
    expect(x('tesoreria')).toBe(x('boveda'));
    expect(layout.edges).toHaveLength(5);
    expect(layout.edges[0].path).toMatch(/^M .* Q /);
    expect(layout.width).toBeGreaterThan(x('boveda'));
  });

  test('árbol Exterior → puerta → lugar', () => {
    const data = examplePredio();
    data.doors.push(door('atajo', 'Atajo', 'tesoreria', 'boveda'));
    const tree = buildSiteTree(buildSiteMap(data));
    expect(tree.root.node.id).toBe('exterior');
    const [first] = tree.root.children;
    expect(first.door.name).toBe('Portón principal');
    expect(first.place.node.name).toBe('Estacionamiento');
    const esclusa = first.place.children[0].place.children[0].place;
    expect(esclusa.node.id).toBe('esclusa');
    expect(esclusa.children.map((c) => c.place.node.id).sort()).toEqual(['boveda', 'tesoreria']);
    const tesoreria = esclusa.children.find((c) => c.place.node.id === 'tesoreria').place;
    expect(tesoreria.children).toEqual([expect.objectContaining({ repeat: true })]);
    expect(tree.unreachable).toEqual([]);
  });
});
