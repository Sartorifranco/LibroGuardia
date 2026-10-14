'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDoorsConfig } = require('../lib/doorsConfig');

test('la puerta simple guarda lados, tipo, sensor, aviso y aprobación', () => {
  const config = normalizeDoorsConfig({
    doors: [{
      id: 'porton-clientes',
      name: 'Portón de clientes',
      kind: 'gate',
      pulseSeconds: 5,
      sensorsRequired: true,
      heldOpenSec: 60,
      requireGuardApproval: true,
      notifyGuardOnVisitor: true,
      manualOpenAllowed: true,
      sides: {
        in: { zoneFrom: 'exterior', zoneTo: 'planta' },
        out: { zoneFrom: 'planta', zoneTo: 'exterior' }
      }
    }]
  }, {}, { strict: true });
  const door = config.doors[0];
  assert.equal(door.kind, 'gate');
  assert.equal(door.pulseSeconds, 5);
  assert.equal(door.unlockSec, 5);
  assert.equal(door.sensorsRequired, true);
  assert.equal(door.heldOpenSec, 60);
  assert.equal(door.requireGuardApproval, true);
  assert.equal(door.notifyGuardOnVisitor, true);
  assert.deepEqual(door.sides, {
    in: { zoneFrom: 'exterior', zoneTo: 'planta' },
    out: { zoneFrom: 'planta', zoneTo: 'exterior' }
  });
});

test('dos lugares iguales no se guardan', () => {
  assert.throws(() => normalizeDoorsConfig({
    doors: [{
      name: 'Puerta',
      sides: { in: { zoneFrom: 'planta', zoneTo: 'planta' } }
    }]
  }, {}, { strict: true }), /distintos/);
});

test('al leer, un lado inválido se descarta y no rompe la puerta vieja', () => {
  const config = normalizeDoorsConfig({
    doors: [{ id: 'p1', name: 'P1', sides: { in: { zoneFrom: 'planta', zoneTo: 'planta' } } }]
  });
  assert.equal(config.doors[0].sides, undefined);
  assert.equal(config.doors[0].kind, 'door');
});

test('el aviso fuera de rango se rechaza al guardar', () => {
  assert.throws(() => normalizeDoorsConfig({
    doors: [{
      name: 'Puerta',
      sensorsRequired: true,
      heldOpenSec: 2,
      sides: { in: { zoneFrom: 'exterior', zoneTo: 'planta' } }
    }]
  }, {}, { strict: true }), /10 y 600/);
});
