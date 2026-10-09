const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findEmbeddedDni, parseScanData } = require('../dniParser');

describe('dniParser: DNI embebido en ficha', () => {
  it('prioriza la etiqueta DNI/Documento/Doc y normaliza puntos', () => {
    const ficha = 'EMPRESA ACME\nNombre\tAna Maria\nDocumento:\t30.111.222\nOtro\t12345678';
    assert.equal(findEmbeddedDni(ficha), '30111222');
    assert.equal(findEmbeddedDni('Doc 28445555\nNombre Juan'), '28445555');
    assert.equal(findEmbeddedDni('DNI#30111222'), '30111222');
  });

  it('sin etiqueta usa el único número de 7 u 8 dígitos', () => {
    assert.equal(findEmbeddedDni('Codigo\t28445555\nNombre\tLuis'), '28445555');
    assert.equal(findEmbeddedDni('A\t12345678\nB\t87654321'), '');
    assert.equal(findEmbeddedDni('Solo texto\nSin numero'), '');
    assert.equal(findEmbeddedDni('Tel\t1145678901\nNombre\tAna'), '');
  });

  it('un PDF417 de una línea sigue parseándose igual', () => {
    const pdf = '00512345678@PEREZ@JUAN@M@30111222@B@01/01/1980@01/01/2020';
    const scan = parseScanData(pdf);
    assert.equal(scan.format, 'pdf417');
    assert.equal(scan.idNumber, '30111222');
    assert.equal(scan.lastName, 'PEREZ');
  });
});
