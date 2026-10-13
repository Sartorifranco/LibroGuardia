export const EXTERIOR_ID = 'exterior';

export const BOX_W = 170;
export const BOX_H = 56;
const GAP_X = 220;
const GAP_Y = 46;
const PAD = 24;
const HEADER_H = 28;

const PLACE_CHARS = 20;
export const PLACE_LINE_H = 18;
const LABEL_CHAR_W = 6.6;
const LABEL_PAD = 14;
const LABEL_MAX_W = 190;
const LABEL_LINE_H = 14;
const LABEL_T = [0.5, 0.35, 0.65, 0.25, 0.75];
const LABEL_STEP_Y = 18;
const LABEL_GAP = 3;

/** Parte un texto en renglones de hasta `maxChars`; el último renglón se lleva el resto (nunca corta con …). */
export function wrapText(text, maxChars, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach((word) => {
    let rest = word;
    while (rest.length > maxChars && lines.length < maxLines - 1) {
      if (current) { lines.push(current); current = ''; continue; }
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    if (lines.length >= maxLines - 1) {
      current = current ? `${current} ${rest}` : rest;
    } else if (!current) {
      current = rest;
    } else if (current.length + 1 + rest.length <= maxChars) {
      current = `${current} ${rest}`;
    } else {
      lines.push(current);
      current = rest;
    }
  });
  if (current || !lines.length) lines.push(current);
  return lines;
}

/** Tamaño de la etiqueta de una puerta: ancho según el texto hasta 190 px y después 2 renglones. */
export function doorLabelSize(name) {
  const maxChars = Math.floor((LABEL_MAX_W - LABEL_PAD) / LABEL_CHAR_W);
  const lines = wrapText(name, maxChars, 2);
  const longest = Math.max(...lines.map((line) => line.length));
  return {
    lines,
    w: Math.round(longest * LABEL_CHAR_W + LABEL_PAD),
    h: lines.length > 1 ? 8 + lines.length * LABEL_LINE_H : 22
  };
}

const overlaps = (a, b) => (
  a.x < b.x + b.w + LABEL_GAP && b.x < a.x + a.w + LABEL_GAP
  && a.y < b.y + b.h + LABEL_GAP && b.y < a.y + a.h + LABEL_GAP
);

const bezierAt = ({ start, ctrl, end }, t) => {
  const u = 1 - t;
  return {
    x: u * u * start.x + 2 * t * u * ctrl.x + t * t * end.x,
    y: u * u * start.y + 2 * t * u * ctrl.y + t * t * end.y
  };
};

/**
 * Ubica las etiquetas de puertas sin que se pisen entre sí ni con las cajas de lugares.
 * Prueba varios puntos de la línea y, si todos chocan, la corre en vertical de a 18 px.
 * `labels`: [{ id, w, h, start, ctrl, end }]; `obstacles`: rectángulos { x, y, w, h }.
 * Devuelve Map id → { x, y } (centro de la etiqueta).
 */
export function placeDoorLabels(labels, obstacles = []) {
  const placed = [];
  const result = new Map();
  const rectAt = (label, center) => ({ x: center.x - label.w / 2, y: center.y - label.h / 2, w: label.w, h: label.h });
  const free = (rect) => rect.y >= 0
    && !placed.some((other) => overlaps(rect, other))
    && !obstacles.some((box) => overlaps(rect, box));

  labels.forEach((label) => {
    let center = null;
    for (const t of LABEL_T) {
      const candidate = bezierAt(label, t);
      if (free(rectAt(label, candidate))) { center = candidate; break; }
    }
    if (!center) {
      const base = bezierAt(label, 0.5);
      for (let step = 1; step <= 200 && !center; step += 1) {
        for (const sign of [1, -1]) {
          const candidate = { x: base.x, y: base.y + sign * step * LABEL_STEP_Y };
          if (free(rectAt(label, candidate))) { center = candidate; break; }
        }
      }
      if (!center) center = base;
    }
    placed.push(rectAt(label, center));
    result.set(label.id, center);
  });
  return result;
}

/** Ordena los lugares de cada nivel por el promedio de la posición de sus vecinos, para cruzar menos líneas. */
function orderByBarycenter(model) {
  const levels = new Map();
  model.nodes.forEach((node) => {
    levels.set(node.level, [...(levels.get(node.level) || []), node.id]);
  });
  const levelOf = new Map(model.nodes.map((node) => [node.id, node.level]));
  const neighbors = new Map(model.nodes.map((node) => [node.id, []]));
  model.edges.forEach((edge) => {
    neighbors.get(edge.from)?.push(edge.to);
    neighbors.get(edge.to)?.push(edge.from);
  });
  const sorted = [...levels.keys()].sort((a, b) => a - b);
  const index = new Map();
  sorted.forEach((lvl) => levels.get(lvl).forEach((id, i) => index.set(id, i)));

  const sweep = (lvl, ref) => {
    const ids = levels.get(lvl);
    const bary = new Map(ids.map((id) => {
      const near = neighbors.get(id).filter((other) => levelOf.get(other) === ref);
      return [id, near.length ? near.reduce((sum, other) => sum + index.get(other), 0) / near.length : index.get(id)];
    }));
    ids.sort((a, b) => (bary.get(a) - bary.get(b)) || (index.get(a) - index.get(b)));
    ids.forEach((id, i) => index.set(id, i));
  };

  for (let pass = 0; pass < 3; pass += 1) {
    if (pass % 2 === 0) sorted.slice(1).forEach((lvl) => sweep(lvl, lvl - 1));
    else sorted.slice(0, -1).reverse().forEach((lvl) => sweep(lvl, lvl + 1));
  }
  return index;
}

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

/** Posiciones del dibujo: una columna por nivel, de izquierda (Exterior) a derecha. */
export function layoutSiteMap(model) {
  const pos = new Map();
  const order = orderByBarycenter(model);
  let maxLevel = 0;
  let bottom = PAD + HEADER_H;
  const nextY = new Map();
  [...model.nodes]
    .sort((a, b) => (a.level - b.level) || (order.get(a.id) - order.get(b.id)))
    .forEach((node) => {
      maxLevel = Math.max(maxLevel, node.level);
      const lines = wrapText(node.name, PLACE_CHARS, 2);
      const h = BOX_H + (lines.length - 1) * PLACE_LINE_H;
      const y = nextY.has(node.level) ? nextY.get(node.level) : PAD + HEADER_H;
      nextY.set(node.level, y + h + GAP_Y);
      bottom = Math.max(bottom, y + h);
      pos.set(node.id, { x: PAD + node.level * (BOX_W + GAP_X), y, w: BOX_W, h, lines });
    });

  const pairCount = new Map();
  const pairIndex = new Map();
  const pairKey = (edge) => [edge.from, edge.to].sort().join('|');
  model.edges.forEach((edge) => pairCount.set(pairKey(edge), (pairCount.get(pairKey(edge)) || 0) + 1));

  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const curves = model.edges.map((edge) => {
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
      start = { x: pa.x + BOX_W, y: pa.y + pa.h / 2 };
      end = { x: pb.x + BOX_W, y: pb.y + pb.h / 2 };
      ctrl = { x: pa.x + BOX_W + 60 + Math.abs(spread), y: (start.y + end.y) / 2 + spread };
    } else {
      start = { x: pa.x + BOX_W, y: pa.y + pa.h / 2 };
      end = { x: pb.x, y: pb.y + pb.h / 2 };
      ctrl = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 + spread * 2 };
    }
    return { edge, start, ctrl, end, size: doorLabelSize(edge.name) };
  });

  const centers = placeDoorLabels(
    curves.map(({ edge, start, ctrl, end, size }) => ({ id: edge.id, w: size.w, h: size.h, start, ctrl, end })),
    [...pos.values()].map(({ x, y, w, h }) => ({ x, y, w, h }))
  );

  let right = PAD + (maxLevel + 1) * BOX_W + maxLevel * GAP_X + 80;
  const edges = curves.map(({ edge, start, ctrl, end, size }) => {
    const center = centers.get(edge.id);
    right = Math.max(right, center.x + size.w / 2);
    bottom = Math.max(bottom, center.y + size.h / 2);
    return {
      ...edge,
      path: `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`,
      label: { x: center.x, y: center.y, w: size.w, h: size.h, lines: size.lines }
    };
  });

  return {
    positions: pos,
    edges,
    width: Math.ceil(right + PAD),
    height: Math.ceil(bottom + PAD),
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
