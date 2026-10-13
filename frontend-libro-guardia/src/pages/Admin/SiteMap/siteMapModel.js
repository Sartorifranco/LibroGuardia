export const EXTERIOR_ID = 'exterior';

export const BOX_W = 170;
export const BOX_H = 56;
const GAP_X = 130;
const GAP_Y = 46;
const PAD = 24;
const HEADER_H = 28;

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
      airlockGroupIds: []
    });
  });
  if (!nodes.has(EXTERIOR_ID)) {
    nodes.set(EXTERIOR_ID, { id: EXTERIOR_ID, name: 'Exterior', fixed: true, airlock: false, airlockGroupIds: [] });
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
    if (door.active !== false && sides.count > 0 && sides.hasIn !== sides.hasOut) {
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
    }

    if (ids.length < 2) {
      problems.push({
        id: `airlock-single-${group.id}`,
        type: 'airlock_single_door',
        message: `El estanco ${quote(name)} tiene una sola puerta. Un estanco necesita por lo menos dos.`,
        target: 'puertas',
        refId: group.outerDoorId || ids[0] || null
      });
    } else if (commonList.length === 0) {
      problems.push({
        id: `airlock-apart-${group.id}`,
        type: 'airlock_no_common_place',
        message: `Las puertas del estanco ${quote(name)} no dan a un mismo lugar. Tienen que rodear un solo lugar.`,
        target: 'puertas',
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

/** Posiciones del dibujo: una columna por nivel, de izquierda (Exterior) a derecha. */
export function layoutSiteMap(model) {
  const pos = new Map();
  let maxLevel = 0;
  let maxOrder = 0;
  model.nodes.forEach((node) => {
    maxLevel = Math.max(maxLevel, node.level);
    maxOrder = Math.max(maxOrder, node.order);
    pos.set(node.id, {
      x: PAD + node.level * (BOX_W + GAP_X),
      y: PAD + HEADER_H + node.order * (BOX_H + GAP_Y)
    });
  });

  const pairCount = new Map();
  const pairIndex = new Map();
  const pairKey = (edge) => [edge.from, edge.to].sort().join('|');
  model.edges.forEach((edge) => pairCount.set(pairKey(edge), (pairCount.get(pairKey(edge)) || 0) + 1));

  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const edges = model.edges.map((edge) => {
    const key = pairKey(edge);
    const index = pairIndex.get(key) || 0;
    pairIndex.set(key, index + 1);
    const spread = (index - ((pairCount.get(key) || 1) - 1) / 2) * 34;

    let a = nodeById.get(edge.from);
    let b = nodeById.get(edge.to);
    if (a.level > b.level) [a, b] = [b, a];
    const pa = pos.get(a.id);
    const pb = pos.get(b.id);
    let start;
    let end;
    let ctrl;
    if (a.level === b.level) {
      start = { x: pa.x + BOX_W, y: pa.y + BOX_H / 2 };
      end = { x: pb.x + BOX_W, y: pb.y + BOX_H / 2 };
      ctrl = { x: pa.x + BOX_W + 60 + Math.abs(spread), y: (start.y + end.y) / 2 + spread };
    } else {
      start = { x: pa.x + BOX_W, y: pa.y + BOX_H / 2 };
      end = { x: pb.x, y: pb.y + BOX_H / 2 };
      ctrl = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 + spread * 2 };
    }
    const label = {
      x: 0.25 * start.x + 0.5 * ctrl.x + 0.25 * end.x,
      y: 0.25 * start.y + 0.5 * ctrl.y + 0.25 * end.y
    };
    return {
      ...edge,
      path: `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`,
      label
    };
  });

  return {
    positions: pos,
    edges,
    width: PAD * 2 + (maxLevel + 1) * BOX_W + maxLevel * GAP_X + 80,
    height: PAD * 2 + HEADER_H + (maxOrder + 1) * BOX_H + maxOrder * GAP_Y,
    columnX: (lvl) => PAD + lvl * (BOX_W + GAP_X)
  };
}

/**
 * Árbol para celular: Exterior → puerta → lugar → puerta → …
 * Cada lugar aparece una vez; si otra puerta vuelve a un lugar ya listado, queda como `repeat`.
 */
export function buildSiteTree(model) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(model.edges.map((edge) => [edge.id, edge]));

  const walk = (nodeId, viaEdgeId) => {
    const node = nodeById.get(nodeId);
    const children = node.doorIds
      .filter((doorId) => doorId !== viaEdgeId)
      .map((doorId) => {
        const edge = edgeById.get(doorId);
        const otherId = edge.from === nodeId ? edge.to : edge.from;
        const other = nodeById.get(otherId);
        const isChild = other.parentEdgeId === doorId && other.level > node.level;
        return isChild
          ? { door: edge, place: walk(otherId, doorId) }
          : { door: edge, place: { node: other, children: [] }, repeat: true };
      });
    return { node, children };
  };

  return {
    root: walk(EXTERIOR_ID, null),
    unreachable: model.nodes.filter((node) => !node.reachable)
  };
}
