const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLegajo,
  fuzzyNameMatch,
  buildNominaEmployeeIndex,
  matchCitacionToEmployee
} = require('../lib/personMatch');

test('normalizeLegajo unifica ceros a la izquierda', () => {
  assert.equal(normalizeLegajo('02530'), '2530');
  assert.equal(normalizeLegajo('2530'), '2530');
});

test('fuzzyNameMatch tolera coma en apellido nombre', () => {
  assert.equal(fuzzyNameMatch('GARCIA, Juan Carlos', 'GARCIA Juan Carlos'), true);
  assert.equal(fuzzyNameMatch('ACEVEDO Miguel Angel Fernando', 'ACEVEDO Miguel Angel Fernando'), true);
});

test('matchCitacionToEmployee encuentra por legajo, dni y nombre', () => {
  const employees = [{
    id: 'e1',
    name: 'ACEVEDO Miguel Angel Fernando',
    legajoNormalized: '2530',
    idNumberNormalized: '30461597',
    active: true
  }];
  const index = buildNominaEmployeeIndex(employees);

  assert.ok(matchCitacionToEmployee({ legajoNormalized: '2530', name: 'X' }, index));
  assert.ok(matchCitacionToEmployee({ idNumberNormalized: '30461597' }, index));
  assert.ok(matchCitacionToEmployee({ name: 'ACEVEDO, Miguel Angel Fernando' }, index));
});
