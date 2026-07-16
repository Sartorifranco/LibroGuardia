const test = require('node:test');
const assert = require('node:assert/strict');
const { inferNextMovementFromEntries } = require('../lib/inferMovementType');

test('sin movimientos previos → ingreso', () => {
  assert.equal(inferNextMovementFromEntries([]), 'ingreso');
});

test('último ingreso autorizado → egreso', () => {
  assert.equal(
    inferNextMovementFromEntries([{ movementType: 'ingreso' }]),
    'egreso'
  );
});

test('último egreso → ingreso', () => {
  assert.equal(
    inferNextMovementFromEntries([{ movementType: 'egreso' }]),
    'ingreso'
  );
});
