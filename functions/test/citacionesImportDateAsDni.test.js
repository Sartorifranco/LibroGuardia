const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseImportRows,
  findIdNumberInRow,
  looksLikeDateAsIdNumber
} = require('../citacionesImport');

test('fecha ISO no se trata como DNI', () => {
  assert.equal(looksLikeDateAsIdNumber('2026-07-16'), true);
  assert.equal(looksLikeDateAsIdNumber('16/07/2026'), true);
  assert.equal(looksLikeDateAsIdNumber('30461597'), false);
});

test('findIdNumberInRow ignora diacitacioningreso', () => {
  const found = findIdNumberInRow({
    per__des: 'Silva Pablo Javier',
    per__cod: '2838',
    diacitacioningreso: '2026-07-16',
    sector__des: 'Operaciones'
  });
  assert.equal(found, null);
});

test('N filas de transporte con misma fecha → N citaciones distintas', () => {
  const rows = [
    {
      per__des: 'Silva Pablo Javier',
      per__cod: '2838',
      sector__des: 'Operaciones',
      tarcon__des: 'Custodio',
      diacitacioningreso: '2026-07-16',
      horacitacioningreso: '07:30'
    },
    {
      per__des: 'Pertile Maximiliano Gabriel',
      per__cod: '2664',
      sector__des: 'Operaciones',
      tarcon__des: 'Chofer',
      diacitacioningreso: '2026-07-16',
      horacitacioningreso: '08:00'
    },
    {
      per__des: 'Vargas Lopumo Juan Jose',
      per__cod: '2934',
      sector__des: 'Operaciones',
      tarcon__des: 'Custodio',
      diacitacioningreso: '2026-07-16',
      horacitacioningreso: '07:30'
    }
  ];

  const { parsed, errors } = parseImportRows(rows, { type: 'citacion' });
  assert.equal(errors.length, 0);
  assert.equal(parsed.length, 3);

  const legajos = new Set(parsed.map((row) => row.legajoNormalized));
  assert.equal(legajos.size, 3);
  assert.ok(parsed.every((row) => row.startDate === '2026-07-16'));
  assert.ok(parsed.every((row) => row.idNumberNormalized !== '20260716'));
  assert.ok(parsed.every((row) => !row.idNumberNormalized || row.idNumberNormalized.length >= 7));
});
