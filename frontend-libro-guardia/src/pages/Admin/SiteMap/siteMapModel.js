export const EXTERIOR_ID = 'exterior';

const normName = (name) => String(name || '').trim().toLowerCase();
const quote = (name) => `“${String(name || '').trim() || 'sin nombre'}”`;

function readerSides(door) {
  const readers = Array.isArray(door.readers) ? door.readers : [];
  let hasIn = readers.some((r) => r?.side === 'in' || r?.direction === 'ingreso');
  let hasOut = readers.some((r) => r?.side === 'out' || r?.direction === 'egreso');
  if (door.readersMode === 'both') { hasIn = true; hasOut = true; }
  return { count: readers.length, hasIn, hasOut };
}

function doorZones(door) {
  const inn = door?.sides?.in || {};
  return { from: inn.zoneFrom || '', to: inn.zoneTo || '' };
}

/**
 * Arma el grafo del predio: lugares = nodos, puertas = aristas.
 * Nivel = cantidad mínima de puertas desde Exterior. Los lugares a los que
 * no se llega quedan en una columna aparte (`reachable: false`).
 */
export function buildSiteMap({ areas = [], doors = [], airlockGroups = [] } = {}) {
  const nodes = new Map();
  (Array.isArray(areas) ? areas : []).forEach((area) => {
    if (!area?.id || nodes.has(area.id)) return;
    nodes.set(area.id, {
      id: area.id,
      name: String(area.name || area.id),
      fixed: Boolean(area.fixed) || area.id === EXTERIOR_ID,
      airlock: false,
      airlockGroupIds: [],
      airlockDoorIds: []
    });
  });
  if (!nodes.has(EXTERIOR_ID)) {
    nodes.set(EXTERIOR_ID, { id: EXTERIOR_ID, name: 'Exterior', fixed: true, airlock: false, airlockGroupIds: [], airlockDoorIds: [] });
  }

  const problems = [];
  const edges = [];
  const doorList = Array.isArray(doors) ? doors : [];
  const doorById = new Map();

  doorList.forEach((door) => {
    if (!door?.id) return;
    doorById.set(door.id, door);
    const name = String(door.name || door.id);
    const { from, to } = doorZones(door);
    if (!from || !to) {
      problems.push({
        id: `door-sides-${door.id}`,
        type: 'door_sides',
        message: `La puerta ${quote(name)} no dice qué dos lugares une.`,
        target: 'puertas',
        refId: door.id
      });
      return;
    }
    if (from === to) {
      problems.push({
        id: `door-same-${door.id}`,
        type: 'door_same_place',
        message: `La puerta ${quote(name)} tiene el mismo lugar de los dos lados.`,
        target: 'puertas',
        refId: door.id
      });
      return;
    }
    const missing = [from, to].filter((zone) => !nodes.has(zone));
    if (missing.length) {
      problems.push({
        id: `door-missing-${door.id}`,
        type: 'door_missing_place',
        message: `La puerta ${quote(name)} usa un lugar que ya no existe.`,
        target: 'puertas',
        refId: door.id
      });
      return;
    }
    edges.push({
      id: door.id,
      name,
      kind: door.kind === 'gate' || door.kind === 'turnstile' ? door.kind : 'door',
      active: door.active !== false,
      from,
      to
    });

    const sides = readerSides(door);
    if (door.active !== false && door.singleSideReaderOk !== true && sides.count > 0 && sides.hasIn !== sides.hasOut) {
      problems.push({
        id: `door-reader-${door.id}`,
        type: 'reader_one_side',
        message: sides.hasIn
          ? `La puerta ${quote(name)} tiene lector de un solo lado: registra quién entra pero no quién sale.`
          : `La puerta ${quote(name)} tiene lector de un solo lado: registra quién sale pero no quién entra.`,
        target: 'puertas',
        refId: door.id
      });
    }
  });

  (Array.isArray(airlockGroups) ? airlockGroups : []).forEach((group) => {
    if (!group?.id) return;
    const name = String(group.name || 'sin nombre');
    const ids = (Array.isArray(group.doorIds) ? group.doorIds : []).filter((id) => doorById.has(id));
    const outer = doorById.get(group.outerDoorId);
    const outerTo = outer ? doorZones(outer).to : '';
    let common = null;
    ids.forEach((id) => {
      const { from, to } = doorZones(doorById.get(id));
      const set = new Set([from, to].filter(Boolean));
      common = common == null ? set : new Set([...common].filter((zone) => set.has(zone)));
    });
    const commonList = common ? [...common] : [];
    const place = (outerTo && nodes.has(outerTo) && outerTo !== EXTERIOR_ID)
      ? outerTo
      : commonList.find((zone) => zone !== EXTERIOR_ID && nodes.has(zone));
    if (place) {
      const node = nodes.get(place);
      node.airlock = true;
      node.airlockGroupIds.push(group.id);
      node.airlockDoorIds = [...new Set([...node.airlockDoorIds, ...ids])];
    }

    if (ids.length < 2) {
      problems.push({
        id: `airlock-single-${group.id}`,
        type: 'airlock_single_door',
        message: `El estanco ${quote(name)} tiene una sola puerta. Un estanco necesita por lo menos dos.`,
        target: 'estancos',
        refId: group.outerDoorId || ids[0] || null
      });
    } else if (commonList.length === 0) {
      problems.push({
        id: `airlock-apart-${group.id}`,
        type: 'airlock_no_common_place',
        message: `Las puertas del estanco ${quote(name)} no dan a un mismo lugar. Tienen que rodear un solo lugar.`,
        target: 'estancos',
        refId: group.outerDoorId || ids[0]
      });
    }
  });

  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  edges.forEach((edge) => {
    adjacency.get(edge.from).push({ edge, other: edge.to });
    adjacency.get(edge.to).push({ edge, other: edge.from });
  });

  const level = new Map([[EXTERIOR_ID, 0]]);
  const parentEdge = new Map();
  const queue = [EXTERIOR_ID];
  while (queue.length) {
    const current = queue.shift();
    adjacency.get(current).forEach(({ edge, other }) => {
      if (level.has(other)) return;
      level.set(other, level.get(current) + 1);
      parentEdge.set(other, edge.id);
      queue.push(other);
    });
  }

  nodes.forEach((node) => {
    if (node.id === EXTERIOR_ID) return;
    const doorCount = adjacency.get(node.id).length;
    if (doorCount === 0) {
      problems.push({
        id: `place-alone-${node.id}`,
        type: 'place_no_doors',
        message: `El lugar ${quote(node.name)} no tiene ninguna puerta.`,
        target: 'puertas',
        refId: node.id
      });
    } else if (!level.has(node.id)) {
      problems.push({
        id: `place-unreachable-${node.id}`,
        type: 'place_unreachable',
        message: `No se puede llegar a ${quote(node.name)} desde Exterior. Falta una puerta que lo conecte con el resto.`,
        target: 'puertas',
        refId: node.id
      });
    }
  });

  const byName = new Map();
  nodes.forEach((node) => {
    const key = normName(node.name);
    if (!key) return;
    byName.set(key, [...(byName.get(key) || []), node]);
  });
  byName.forEach((list) => {
    if (list.length < 2) return;
    problems.push({
      id: `place-dup-${normName(list[0].name)}`,
      type: 'duplicate_place_name',
      message: `Hay ${list.length} lugares que se llaman ${quote(list[0].name)}. Cambiale el nombre a uno para no confundirlos.`,
      target: 'lugares',
      refId: list[1].id
    });
  });

  const maxLevel = Math.max(0, ...level.values());
  const unreachableLevel = maxLevel + 1;
  const byLevel = new Map();
  nodes.forEach((node) => {
    const reachable = level.has(node.id);
    node.reachable = reachable;
    node.level = reachable ? level.get(node.id) : unreachableLevel;
    node.parentEdgeId = parentEdge.get(node.id) || null;
    node.doorIds = adjacency.get(node.id).map((item) => item.edge.id);
    byLevel.set(node.level, [...(byLevel.get(node.level) || []), node]);
  });

  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const orderOf = new Map();
  [...byLevel.keys()].sort((a, b) => a - b).forEach((lvl) => {
    const parentOrder = (node) => {
      const edge = edgeById.get(node.parentEdgeId);
      if (!edge) return Infinity;
      const parent = edge.from === node.id ? edge.to : edge.from;
      return orderOf.has(parent) ? orderOf.get(parent) : Infinity;
    };
    byLevel.get(lvl)
      .sort((a, b) => (parentOrder(a) - parentOrder(b)) || a.name.localeCompare(b.name, 'es'))
      .forEach((node, index) => {
        node.order = index;
        orderOf.set(node.id, index);
      });
  });

  const nodeList = [...nodes.values()].sort((a, b) => (a.level - b.level) || (a.order - b.order));
  return {
    nodes: nodeList,
    edges,
    problems,
    hasUnreachable: nodeList.some((node) => !node.reachable)
  };
}

const byName = (a, b) => a.localeCompare(b, 'es');

/**
 * Recorrido: Exterior → puerta → lugar → puerta → …
 * Cada lugar aparece una sola vez, debajo del lugar desde el que se llega con menos puertas
 * (empates por nombre). Una puerta hacia un lugar que ya figura más arriba queda como `repeat`.
 * Los lugares a los que no se llega desde Exterior arman sus propios recorridos en `unreachable`.
 */
export function buildSiteTree(model) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const links = new Map(model.nodes.map((node) => [node.id, []]));
  model.edges.forEach((edge) => {
    links.get(edge.from).push({ door: edge, otherId: edge.to });
    links.get(edge.to).push({ door: edge, otherId: edge.from });
  });
  links.forEach((list) => list.sort((a, b) => (
    byName(nodeById.get(a.otherId).name, nodeById.get(b.otherId).name) || byName(a.door.name, b.door.name)
  )));

  const viaDoor = new Map();
  const childLinks = new Map();
  const spread = (rootId) => {
    viaDoor.set(rootId, null);
    const queue = [rootId];
    while (queue.length) {
      const current = queue.shift();
      childLinks.set(current, []);
      links.get(current).forEach((link) => {
        if (viaDoor.has(link.otherId)) return;
        viaDoor.set(link.otherId, link.door.id);
        childLinks.get(current).push(link);
        queue.push(link.otherId);
      });
    }
  };
  spread(EXTERIOR_ID);
  const aloneRoots = [];
  model.nodes
    .filter((node) => !viaDoor.has(node.id))
    .sort((a, b) => byName(a.name, b.name))
    .forEach((node) => {
      if (viaDoor.has(node.id)) return;
      spread(node.id);
      aloneRoots.push(node.id);
    });

  const shownAt = new Map();
  const numberFrom = (id) => {
    shownAt.set(id, shownAt.size);
    childLinks.get(id).forEach((link) => numberFrom(link.otherId));
  };
  numberFrom(EXTERIOR_ID);
  aloneRoots.forEach(numberFrom);

  const walk = (id) => {
    const childDoors = new Set(childLinks.get(id).map((link) => link.door.id));
    const children = links.get(id)
      .filter(({ door, otherId }) => childDoors.has(door.id)
        || (door.id !== viaDoor.get(id) && shownAt.get(otherId) < shownAt.get(id)))
      .map(({ door, otherId }) => (childDoors.has(door.id)
        ? { door, place: walk(otherId) }
        : { door, place: { node: nodeById.get(otherId), children: [] }, repeat: true }));
    return { node: nodeById.get(id), children };
  };

  return {
    root: walk(EXTERIOR_ID),
    unreachable: aloneRoots.map(walk)
  };
}
