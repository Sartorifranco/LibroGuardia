export const GATE_TARGETS = [
  { id: 'gate-1', name: 'Portón Santiago' },
  { id: 'gate-2', name: 'Portón Olmos' }
];

export const normalizeGatePolygonsForSave = (gatePolygons = []) => GATE_TARGETS.map((target, index) => {
  const existing = (gatePolygons || []).find((gate) => gate.id === target.id)
    || gatePolygons?.[index];
  return {
    id: target.id,
    name: target.name,
    points: Array.isArray(existing?.points) ? existing.points : []
  };
});

export const buildGatePolygonPatch = (drawTarget, draftPoints, gatePolygons = []) => {
  if (!Array.isArray(draftPoints) || draftPoints.length < 3) return null;

  if (drawTarget === 'plant') {
    return {
      geofenceMode: 'polygon',
      plantPolygon: { points: draftPoints }
    };
  }

  const nextGates = normalizeGatePolygonsForSave(gatePolygons).map((gate) => (
    gate.id === drawTarget ? { ...gate, points: draftPoints } : gate
  ));

  return {
    geofenceMode: 'polygon',
    gatePolygons: nextGates
  };
};
