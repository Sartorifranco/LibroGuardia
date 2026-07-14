const toPoint = (value) => {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    const lat = Number(value[0]);
    const lng = Number(value[1]);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return [lat, lng];
  }
  if (value.lat != null && value.lng != null) return toPoint([value.lat, value.lng]);
  return null;
};

const normalizePolygonPoints = (points = []) => {
  if (!Array.isArray(points)) return [];
  return points.map(toPoint).filter(Boolean);
};

const pointInPolygon = (lat, lng, points = []) => {
  const ring = normalizePolygonPoints(points);
  if (ring.length < 3) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const intersect = ((latI > lat) !== (latJ > lat))
      && (lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI + 1e-12) + lngI);
    if (intersect) inside = !inside;
  }
  return inside;
};

const distancePointToSegment = (lat, lng, latA, lngA, latB, lngB, distanceFn) => {
  const samples = 5;
  let min = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const sampleLat = latA + ((latB - latA) * t);
    const sampleLng = lngA + ((lngB - lngA) * t);
    const d = distanceFn(lat, lng, sampleLat, sampleLng);
    if (d < min) min = d;
  }
  return min;
};

const distanceToPolygon = (lat, lng, points = [], distanceFn) => {
  const ring = normalizePolygonPoints(points);
  if (ring.length < 3) return null;
  if (pointInPolygon(lat, lng, ring)) return 0;

  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i++) {
    const [latA, lngA] = ring[i];
    const [latB, lngB] = ring[(i + 1) % ring.length];
    const d = distancePointToSegment(lat, lng, latA, lngA, latB, lngB, distanceFn);
    if (d < min) min = d;
  }
  return Math.round(min);
};

const GATE_DEFAULT_NAMES = {
  'gate-1': 'Portón Santiago',
  'gate-2': 'Portón Olmos'
};

const normalizeGateName = (id, name) => {
  const trimmed = String(name || '').trim();
  if (/^port[oó]n\s*1$/i.test(trimmed)) return GATE_DEFAULT_NAMES['gate-1'];
  if (/^port[oó]n\s*2$/i.test(trimmed)) return GATE_DEFAULT_NAMES['gate-2'];
  return trimmed || GATE_DEFAULT_NAMES[id] || trimmed;
};

const firestorePoints = (points = []) => (
  normalizePolygonPoints(points).map(([lat, lng]) => ({ lat, lng }))
);

const persistGatePolygons = (input) => {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 4)
    .map((gate, index) => {
      const id = String(gate?.id || `gate-${index + 1}`);
      return {
        id,
        name: normalizeGateName(id, gate?.name || GATE_DEFAULT_NAMES[id] || `Portón ${index + 1}`),
        points: firestorePoints(gate?.points)
      };
    });
};

const formatGatePolygonsForApi = (input) => {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 4)
    .map((gate, index) => {
      const id = String(gate?.id || `gate-${index + 1}`);
      return {
        id,
        name: normalizeGateName(id, gate?.name || GATE_DEFAULT_NAMES[id] || `Portón ${index + 1}`),
        points: normalizePolygonPoints(gate?.points)
      };
    });
};

const sanitizeGatePolygons = (input) => (
  persistGatePolygons(input).filter((gate) => gate.points.length >= 3)
);

const sanitizePlantPolygon = (input) => {
  if (!input || typeof input !== 'object') return null;
  const points = normalizePolygonPoints(input.points);
  if (points.length < 3) return null;
  return { points };
};

const persistPlantPolygon = (input) => {
  const plant = sanitizePlantPolygon(input);
  if (!plant) return null;
  return { points: firestorePoints(plant.points) };
};

const formatPlantPolygonForApi = (input) => {
  const plant = sanitizePlantPolygon(input);
  if (!plant) return null;
  return plant;
};

const usesPolygonGeofence = (config = {}) => {
  if (config.geofenceMode !== 'polygon') return false;
  return sanitizeGatePolygons(config.gatePolygons).length > 0;
};

const resolveVehicleGeofence = (lat, lng, config = {}, distanceFn) => {
  const gatePolygons = sanitizeGatePolygons(config.gatePolygons);
  const plantPolygon = sanitizePlantPolygon(config.plantPolygon);
  const guardiaLat = Number(config.guardiaLat);
  const guardiaLng = Number(config.guardiaLng);
  const gateRadius = Number(config.gateRadiusMeters ?? config.alertRadiusMeters) || 45;
  const plantRadius = Number(config.plantRadiusMeters) || 400;

  if (usesPolygonGeofence(config)) {
    for (const gate of gatePolygons) {
      if (pointInPolygon(lat, lng, gate.points)) {
        return {
          zone: 'gate',
          gateId: gate.id,
          gateName: gate.name,
          distanceMeters: 0
        };
      }
    }

    if (plantPolygon && pointInPolygon(lat, lng, plantPolygon.points)) {
      return {
        zone: 'plant',
        distanceMeters: 0
      };
    }

    let minGateDistance = Number.POSITIVE_INFINITY;
    gatePolygons.forEach((gate) => {
      const d = distanceToPolygon(lat, lng, gate.points, distanceFn);
      if (d != null && d < minGateDistance) minGateDistance = d;
    });

    if (!Number.isNaN(guardiaLat) && !Number.isNaN(guardiaLng)) {
      const centerDistance = Math.round(distanceFn(guardiaLat, guardiaLng, lat, lng));
      if (!plantPolygon && centerDistance <= plantRadius) {
        return {
          zone: 'plant',
          distanceMeters: centerDistance
        };
      }
      if (Number.isFinite(minGateDistance)) {
        return {
          zone: 'outside',
          distanceMeters: minGateDistance
        };
      }
      return {
        zone: 'outside',
        distanceMeters: centerDistance
      };
    }

    return {
      zone: 'outside',
      distanceMeters: Number.isFinite(minGateDistance) ? minGateDistance : null
    };
  }

  if (Number.isNaN(guardiaLat) || Number.isNaN(guardiaLng)) {
    return { zone: 'unknown', distanceMeters: null };
  }

  const distance = Math.round(distanceFn(guardiaLat, guardiaLng, lat, lng));
  if (distance <= gateRadius) {
    return { zone: 'gate', distanceMeters: distance };
  }
  if (distance <= plantRadius) {
    return { zone: 'plant', distanceMeters: distance };
  }
  return { zone: 'outside', distanceMeters: distance };
};

module.exports = {
  toPoint,
  normalizePolygonPoints,
  pointInPolygon,
  distanceToPolygon,
  sanitizeGatePolygons,
  persistGatePolygons,
  formatGatePolygonsForApi,
  sanitizePlantPolygon,
  persistPlantPolygon,
  formatPlantPolygonForApi,
  usesPolygonGeofence,
  resolveVehicleGeofence
};
