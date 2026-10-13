import { buildSiteMap, buildSiteTree, doorLabelSize, layoutSiteMap, placeDoorLabels, wrapText } from './siteMapModel';

const rectsOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const labelRect = (label) => ({ x: label.x - label.w / 2, y: label.y - label.h / 2, w: label.w, h: label.h });

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

  test('lector de un solo lado marcado como “está bien así” no se reporta', () => {
    const data = examplePredio();
    data.doors[1].readers = [{ side: 'in' }];
    data.doors[1].singleSideReaderOk = true;
    data.doors[0].readers = [{ side: 'out' }];
    const model = buildSiteMap(data);
    expect(model.problems.map((p) => p.refId)).toEqual(['porton']);
  });

  test('estanco con una sola puerta o con puertas que no tocan un mismo lugar', () => {
    const data = examplePredio();
    data.airlockGroups.push({ id: 'g2', name: 'Solito', doorIds: ['p-planta'], outerDoorId: 'p-planta' });
    data.airlockGroups.push({ id: 'g3', name: 'Separado', doorIds: ['porton', 'e2'], outerDoorId: 'porton' });
    const model = buildSiteMap(data);
    expect(types(model)).toEqual(['airlock_single_door', 'airlock_no_common_place']);
    expect(model.problems[0].message).toMatch(/“Solito” tiene una sola puerta/);
    expect(model.problems[1].message).toMatch(/“Separado” no dan a un mismo lugar/);
    expect(model.problems.map((p) => p.target)).toEqual(['estancos', 'estancos']);
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

  test('nombres largos en dos renglones, sin …', () => {
    expect(wrapText('Planta', 20)).toEqual(['Planta']);
    expect(wrapText('Ingreso Tesorería y Camioneros', 20)).toEqual(['Ingreso Tesorería y', 'Camioneros']);
    expect(wrapText('Superlargodesdeelprincipiohastaelfin', 20)).toEqual(['Superlargodesdeelpri', 'ncipiohastaelfin']);
    const corto = doorLabelSize('Portón 1');
    expect(corto).toMatchObject({ lines: ['Portón 1'], h: 22 });
    expect(corto.w).toBe(Math.round(8 * 6.6 + 14));
    const largo = doorLabelSize('Ingreso Tesorería y Camioneros por Planta');
    expect(largo.lines).toHaveLength(2);
    expect(largo.lines.join(' ')).toBe('Ingreso Tesorería y Camioneros por Planta');
    expect(largo.w).toBeLessThanOrEqual(190);

    const data = examplePredio();
    data.areas.find((a) => a.id === 'planta').name = 'Planta de recuento y clasificación';
    const layout = layoutSiteMap(buildSiteMap(data));
    const planta = layout.positions.get('planta');
    expect(planta.lines).toEqual(['Planta de recuento y', 'clasificación']);
    expect(planta.h).toBeGreaterThan(layout.positions.get('esclusa').h);
    const text = JSON.stringify([...layout.positions.values(), ...layout.edges.map((e) => e.label)]);
    expect(text).not.toMatch(/…/);
  });

  test('placeDoorLabels: 4 etiquetas que cruzan la misma columna no se pisan', () => {
    const line = { start: { x: 0, y: 100 }, ctrl: { x: 200, y: 100 }, end: { x: 400, y: 100 } };
    const labels = ['a', 'b', 'c', 'd'].map((id) => ({ id, w: 150, h: 22, ...line }));
    const boxes = [{ x: 170, y: 140, w: 60, h: 40 }];
    const centers = placeDoorLabels(labels, boxes);
    const rects = labels.map((l) => labelRect({ ...centers.get(l.id), w: l.w, h: l.h }));
    rects.forEach((a, i) => {
      rects.slice(i + 1).forEach((b) => expect(rectsOverlap(a, b)).toBe(false));
      boxes.forEach((box) => expect(rectsOverlap(a, box)).toBe(false));
    });
    expect(centers.get('a')).toEqual({ x: 200, y: 100 });
  });

  test('layoutSiteMap: puertas que cruzan la misma columna no tapan etiquetas ni lugares', () => {
    const areas = [
      { id: 'exterior', name: 'Exterior', fixed: true },
      { id: 'playa', name: 'Playa' },
      { id: 'planta', name: 'Planta' },
      { id: 'teso', name: 'Tesorería' },
      { id: 'estanco', name: 'Estanco 1' },
      { id: 'boveda', name: 'Bóveda' }
    ];
    const doors = [
      door('p1', 'Portón 1 Planta', 'exterior', 'playa', { kind: 'gate' }),
      door('p2', 'Portón 2 Planta', 'playa', 'planta', { kind: 'gate' }),
      door('teso', 'Ingreso Teso y Camioneros', 'playa', 'teso'),
      door('est', 'Estanco 1 Playa', 'playa', 'estanco'),
      door('x1', 'Paso directo a bóveda desde playa', 'playa', 'boveda'),
      door('x2', 'Planta a Tesorería', 'planta', 'teso')
    ];
    const layout = layoutSiteMap(buildSiteMap({ areas, doors }));
    const rects = layout.edges.map((e) => labelRect(e.label));
    const boxes = [...layout.positions.values()];
    rects.forEach((a, i) => {
      rects.slice(i + 1).forEach((b) => expect(rectsOverlap(a, b)).toBe(false));
      boxes.forEach((box) => expect(rectsOverlap(a, box)).toBe(false));
      expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
    });
  });

  test('ordena cada nivel por sus vecinos para cruzar menos líneas', () => {
    const areas = [
      { id: 'exterior', name: 'Exterior', fixed: true },
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'z1', name: 'Z1' },
      { id: 'z2', name: 'Z2' }
    ];
    const doors = [
      door('d1', 'D1', 'exterior', 'a'),
      door('d2', 'D2', 'exterior', 'b'),
      door('d3', 'D3', 'a', 'z2'),
      door('d4', 'D4', 'b', 'z1')
    ];
    const layout = layoutSiteMap(buildSiteMap({ areas, doors }));
    const y = (id) => layout.positions.get(id).y;
    expect(y('a')).toBeLessThan(y('b'));
    expect(y('z2')).toBeLessThan(y('z1'));
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
