const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAreaShort, getAreaKey, buildAreaGroups } = require('../lib/centroCostoGroups');

test('extractAreaShort acorta BACAR SA - Transporte', () => {
  assert.equal(extractAreaShort('BACAR SA - Transporte'), 'Transporte');
});

test('extractAreaShort toma primer segmento antes de coma', () => {
  assert.equal(extractAreaShort('BACAR SA - Tesorería, T'), 'Tesorería');
  assert.equal(extractAreaShort('GRUAS - Transporte, GRUAS - SE'), 'Grúas');
});

test('extractAreaShort devuelve Sin área para vacío', () => {
  assert.equal(extractAreaShort(''), 'Sin área');
  assert.equal(getAreaKey(''), '__empty__');
});

test('buildAttendanceAreaSummary incluye todas las areas de nomina', () => {
  const { buildAttendanceAreaSummary } = require('../lib/centroCostoGroups');
  const all = [
    { centroCosto: 'BACAR SA - Transporte' },
    { centroCosto: 'BACAR SA - Sistemas' },
    { centroCosto: 'BACAR SA - Sistemas' }
  ];
  const roster = [
    { areaKey: 'transporte', centroCosto: 'BACAR SA - Transporte', status: 'present' }
  ];
  const areas = buildAttendanceAreaSummary(all, roster);
  assert.equal(areas.length, 2);
  const transporte = areas.find((a) => a.label === 'Transporte');
  const sistemas = areas.find((a) => a.label === 'Sistemas');
  assert.equal(transporte.totalInNomina, 1);
  assert.equal(transporte.expectedToday, 1);
  assert.equal(sistemas.totalInNomina, 2);
  assert.equal(sistemas.expectedToday, 0);
});

test('extractAreaShort corrige administracion truncada', () => {
  assert.equal(extractAreaShort('BACAR SA - Administració'), 'Administración');
});

test('buildAreaGroups agrupa centros similares', () => {
  const groups = buildAreaGroups([
    { centroCosto: 'BACAR SA - Transporte' },
    { centroCosto: 'BACAR SA - Transporte, BACAR S' },
    { centroCosto: 'BACAR SA - Sistemas' }
  ]);
  const transporte = groups.find((g) => g.label === 'Transporte');
  const sistemas = groups.find((g) => g.label === 'Sistemas');
  assert.equal(transporte?.count, 2);
  assert.equal(sistemas?.count, 1);
});
