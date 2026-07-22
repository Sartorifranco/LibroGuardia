const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseReaderPrefixedScan } = require('../lib/doorsConfig');

describe('parseReaderPrefixedScan', () => {
  it('parsea INGRESO_P1#dni', () => {
    const r = parseReaderPrefixedScan('INGRESO_P1#30111222');
    assert.equal(r.readerId, 'INGRESO_P1');
    assert.equal(r.direction, 'ingreso');
    assert.equal(r.doorCode, 'P1');
    assert.equal(r.payload, '30111222');
  });

  it('parsea EGRESO_P1#dni', () => {
    const r = parseReaderPrefixedScan('EGRESO_P1#30111222');
    assert.equal(r.readerId, 'EGRESO_P1');
    assert.equal(r.direction, 'egreso');
    assert.equal(r.payload, '30111222');
  });

  it('sin prefijo devuelve null', () => {
    assert.equal(parseReaderPrefixedScan('30111222'), null);
  });
});
