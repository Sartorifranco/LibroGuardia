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
  assert.equal(getEffectiveEntryType({ type: 'vehiculo' }), 'vehiculo');
  assert.equal(getEffectiveEntryType({ type: 'personal' }), 'personal');
});

test('matchesTypeFilter y matchesSearch', () => {
  assert.equal(matchesTypeFilter({ type: 'novedad' }, 'todos'), true);
  assert.equal(matchesTypeFilter({ type: 'novedad' }, 'novedad'), true);
  assert.equal(matchesTypeFilter({ type: 'personal' }, 'novedad'), false);
  assert.equal(matchesSearch({ name: 'Juan Perez', plate: 'AB123CD' }, 'juan'), true);
  assert.equal(matchesSearch({ name: 'Juan Perez' }, 'zzz'), false);
});
