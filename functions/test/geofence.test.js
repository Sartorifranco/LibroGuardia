const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pointInPolygon,
  sanitizeGatePolygons,
  usesPolygonGeofence,
  resolveVehicleGeofence
} = require('../lib/geofence');

const distanceFn = (lat1, lng1, lat2, lng2) => {
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  return Math.sqrt((dLat * dLat) + (dLng * dLng)) * 111000;
};

test('pointInPolygon detecta punto dentro de un rectángulo', () => {
  const square = [
    [-31.415, -64.178],
    [-31.415, -64.176],
    [-31.414, -64.176],
    [-31.414, -64.178]
  ];
  assert.equal(pointInPolygon(-31.4145, -64.177, square), true);
  assert.equal(pointInPolygon(-31.416, -64.177, square), false);
});

test('sanitizeGatePolygons filtra polígonos inválidos', () => {
  const gates = sanitizeGatePolygons([
    { id: 'gate-1', name: 'Portón A', points: [[-31.415, -64.178], [-31.415, -64.176], [-31.414, -64.177]] },
    { id: 'gate-2', name: 'Portón B', points: [[-31.415, -64.178]] }
  ]);
  assert.equal(gates.length, 1);
  assert.equal(gates[0].name, 'Portón A');
});

test('persistGatePolygons conserva portones aunque estén incompletos', () => {
  const { persistGatePolygons } = require('../lib/geofence');
  const gates = persistGatePolygons([
    { id: 'gate-1', name: 'Portón Santiago', points: [[-31.415, -64.178], [-31.415, -64.176], [-31.414, -64.177]] },
    { id: 'gate-2', name: 'Portón Olmos', points: [] }
  ]);
  assert.equal(gates.length, 2);
  assert.equal(gates[1].points.length, 0);
  assert.deepEqual(gates[0].points[0], { lat: -31.415, lng: -64.178 });
});

test('resolveVehicleGeofence usa polígonos de portón', () => {
  const config = {
    geofenceMode: 'polygon',
    guardiaLat: -31.414842,
    guardiaLng: -64.17683,
    gatePolygons: [
      {
        id: 'gate-1',
        name: 'Portón 1',
        points: [
          [-31.415, -64.178],
          [-31.415, -64.176],
          [-31.414, -64.176],
          [-31.414, -64.178]
        ]
      }
    ],
    plantPolygon: {
      points: [
        [-31.416, -64.179],
        [-31.416, -64.175],
        [-31.413, -64.175],
        [-31.413, -64.179]
      ]
    }
  };

  assert.equal(usesPolygonGeofence(config), true);
  assert.equal(resolveVehicleGeofence(-31.4145, -64.177, config, distanceFn).zone, 'gate');
  assert.equal(resolveVehicleGeofence(-31.4135, -64.1775, config, distanceFn).zone, 'plant');
  assert.equal(resolveVehicleGeofence(-31.420, -64.177, config, distanceFn).zone, 'outside');
});
