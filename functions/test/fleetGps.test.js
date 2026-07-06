const test = require('node:test');
const assert = require('node:assert/strict');
const { distanceMeters, extractPlate, resolveZone, isVehicleMoving } = require('../fleetGps');

test('distanceMeters calcula distancia corta', () => {
  const meters = distanceMeters(-31.4, -64.2, -31.401, -64.2);
  assert.ok(meters > 100);
  assert.ok(meters < 130);
});

test('extractPlate obtiene patente del nombre UBIKA', () => {
  assert.equal(extractPlate('Camión 568 - AF973GW'), 'AF973GW');
  assert.equal(extractPlate('Móvil sin patente'), null);
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
