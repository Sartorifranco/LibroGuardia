const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesTypeFilter,
  matchesSearch,
  clampLimit,
  getEffectiveEntryType
} = require('../lib/entriesQuery');

test('clampLimit respeta default y máximo', () => {
  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit(10), 10);
  assert.equal(clampLimit(999), 200);
});

test('getEffectiveEntryType trata GPS vehiculo como flota', () => {
  assert.equal(getEffectiveEntryType({ type: 'vehiculo', gpsAuto: true }), 'flota');
  assert.equal(getEffectiveEntryType({ type: 'vehiculo', entrySource: 'gps_ubika' }), 'flota');
  assert.equal(getEffectiveEntryType({ type: 'vehiculo', entrySource: 'gps_otro' }), 'flota');
  assert.equal(getEffectiveEntryType({ type: 'vehiculo' }), 'vehiculo');
  assert.equal(getEffectiveEntryType({ type: 'personal' }), 'personal');
});

test('entry de producción gps_ubika sigue clasificando como flota', () => {
  const { isGpsFleetEntry } = require('../lib/gpsProviders/entrySource');
  const productionLike = {
    type: 'flota',
    movementType: 'ingreso',
    entrySource: 'gps_ubika',
    gpsAuto: true,
    plate: 'AF973GW',
    mobile: 'Camión 568',
    gpsName: 'Camión 568 - AF973GW',
    gpsDeviceId: 9
  };
  assert.equal(isGpsFleetEntry(productionLike), true);
  assert.equal(getEffectiveEntryType(productionLike), 'flota');
  assert.equal(matchesTypeFilter(productionLike, 'flota'), true);
  assert.equal(matchesTypeFilter(productionLike, 'vehiculo'), false);
});

test('matchesTypeFilter y matchesSearch', () => {
  assert.equal(matchesTypeFilter({ type: 'novedad' }, 'todos'), true);
  assert.equal(matchesTypeFilter({ type: 'novedad' }, 'novedad'), true);
  assert.equal(matchesTypeFilter({ type: 'personal' }, 'novedad'), false);
  assert.equal(matchesSearch({ name: 'Juan Perez', plate: 'AB123CD' }, 'juan'), true);
  assert.equal(matchesSearch({ name: 'Juan Perez' }, 'zzz'), false);
});
