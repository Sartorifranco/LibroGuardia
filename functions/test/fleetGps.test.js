const test = require('node:test');
const assert = require('node:assert/strict');
const { distanceMeters, extractPlate, extractVehicleLabel, resolveZone, isVehicleMoving, normalizeGeoCoordinate, detectApproachingVehicles } = require('../fleetGps');

test('distanceMeters calcula distancia corta', () => {
  const meters = distanceMeters(-31.4, -64.2, -31.401, -64.2);
  assert.ok(meters > 100);
  assert.ok(meters < 130);
});

test('extractPlate obtiene patente del nombre UBIKA', () => {
  assert.equal(extractPlate('Camión 568 - AF973GW'), 'AF973GW');
  assert.equal(extractPlate('Móvil sin patente'), null);
});

test('extractVehicleLabel obtiene tipo de móvil sin patente', () => {
  assert.equal(extractVehicleLabel('Camión 568 - AF973GW', 'AF973GW'), 'Camión 568');
  assert.equal(extractVehicleLabel('UB - UNIDAD BLINDADA'), 'UB - UNIDAD BLINDADA');
  assert.equal(extractVehicleLabel('HILUX AF174HL', 'AF174HL'), 'HILUX');
});

test('resolveZone distingue portón, planta y afuera', () => {
  assert.equal(resolveZone(20, 45, 400), 'gate');
  assert.equal(resolveZone(120, 45, 400), 'plant');
  assert.equal(resolveZone(800, 45, 400), 'outside');
});

test('isVehicleMoving ignora estacionados si requireMotion', () => {
  assert.equal(isVehicleMoving({ motion: false, speed: 0, ignition: true }, { requireMotion: true, minSpeedKnots: 1 }), false);
  assert.equal(isVehicleMoving({ motion: true, speed: 0, ignition: true }, { requireMotion: true, minSpeedKnots: 1 }), true);
  assert.equal(isVehicleMoving({ motion: false, speed: 3, ignition: false }, { requireMotion: true, minSpeedKnots: 1 }), true);
});

test('normalizeGeoCoordinate repara longitud sin punto decimal', () => {
  assert.equal(normalizeGeoCoordinate(-64176830, 'lng'), -64.17683);
  assert.equal(normalizeGeoCoordinate(-31.414842, 'lat'), -31.414842);
});

test('detectApproachingVehicles alerta móviles en movimiento dentro del radio', () => {
  const config = {
    approachAlertEnabled: true,
    approachRadiusMeters: 400,
    approachRequireMotion: true
  };
  const vehicles = [
    { deviceId: 1, name: 'Camión A', zone: 'outside', moving: true, centerDistanceMeters: 320 },
    { deviceId: 2, name: 'Camión B', zone: 'plant', moving: true, centerDistanceMeters: 120 },
    { deviceId: 3, name: 'Camión C', zone: 'outside', moving: false, centerDistanceMeters: 200 }
  ];
  const alerts = detectApproachingVehicles(vehicles, config);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].name, 'Camión A');
});

test('resolveTransitDirection detecta transiciones de zona con movimiento', () => {
  const { resolveTransitDirection } = require('../fleetGps');
  const prev = (zone) => ({ zone });

  assert.equal(resolveTransitDirection({ zone: 'gate', moving: true }, prev('outside')), 'ingreso');
  assert.equal(resolveTransitDirection({ zone: 'plant', moving: true }, prev('outside')), 'ingreso');
  assert.equal(resolveTransitDirection({ zone: 'plant', moving: true }, prev('gate')), 'ingreso');
  assert.equal(resolveTransitDirection({ zone: 'gate', moving: true }, prev('plant')), 'egreso');
  assert.equal(resolveTransitDirection({ zone: 'outside', moving: true }, prev('plant')), 'egreso');
  assert.equal(resolveTransitDirection({ zone: 'outside', moving: true }, prev('gate')), 'egreso');
  assert.equal(resolveTransitDirection({ zone: 'plant', moving: true }, null), null);
  assert.equal(resolveTransitDirection({ zone: 'gate', moving: false }, prev('outside')), null);
});
