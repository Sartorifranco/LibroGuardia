const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDoorsConfig,
  getReaderDirection,
  resolveReaderFixedMovement
} = require('../lib/doorsConfig');

describe('doorsConfig readers direction', () => {
  it('sin readers explícitos: cada readerId queda en ambos (compat)', () => {
    const config = normalizeDoorsConfig({
      doors: [{
        id: 'molinete',
        name: 'Molinete',
        readerIds: ['default', 'guard-desk']
      }]
    });
    const door = config.doors[0];
    assert.deepEqual(door.readerIds, ['default', 'guard-desk']);
    assert.equal(door.readers.length, 2);
    assert.equal(getReaderDirection(door, 'default'), 'ambos');
    assert.equal(getReaderDirection(door, 'guard-desk'), 'ambos');
    assert.equal(resolveReaderFixedMovement(door, 'default'), null);
  });

  it('direction ingreso fija → resolveReaderFixedMovement = ingreso (sin inferir)', () => {
    const config = normalizeDoorsConfig({
      doors: [{
        id: 'entrada',
        name: 'Entrada',
        readers: [{ id: 'lector-in', direction: 'ingreso' }]
      }]
    });
    const door = config.doors[0];
    assert.equal(getReaderDirection(door, 'lector-in'), 'ingreso');
    assert.equal(resolveReaderFixedMovement(door, 'lector-in'), 'ingreso');
    assert.deepEqual(door.readerIds, ['lector-in']);
  });

  it('direction egreso fija → resolveReaderFixedMovement = egreso', () => {
    const config = normalizeDoorsConfig({
      doors: [{
        id: 'salida',
        name: 'Salida',
        readers: [{ id: 'lector-out', direction: 'egreso' }]
      }]
    });
    const door = config.doors[0];
    assert.equal(resolveReaderFixedMovement(door, 'lector-out'), 'egreso');
  });

  it('direction ambos o reader desconocido → null (inferencia automática)', () => {
    const config = normalizeDoorsConfig({
      doors: [{
        id: 'doble',
        name: 'Doble sentido',
        readers: [{ id: 'ambos-sides', direction: 'ambos' }]
      }]
    });
    const door = config.doors[0];
    assert.equal(resolveReaderFixedMovement(door, 'ambos-sides'), null);
    assert.equal(resolveReaderFixedMovement(door, 'no-existe'), null);
    assert.equal(getReaderDirection(door, 'no-existe'), 'ambos');
  });

  it('al actualizar readerIds se conservan directions previas por id', () => {
    const config = normalizeDoorsConfig({
      doors: [{
        id: 'p1',
        name: 'P1',
        readers: [
          { id: 'in', direction: 'ingreso' },
          { id: 'out', direction: 'egreso' }
        ],
        readerIds: ['in', 'out', 'nuevo']
      }]
    });
    const door = config.doors[0];
    assert.equal(resolveReaderFixedMovement(door, 'in'), 'ingreso');
    assert.equal(resolveReaderFixedMovement(door, 'out'), 'egreso');
    assert.equal(resolveReaderFixedMovement(door, 'nuevo'), null);
  });
});
