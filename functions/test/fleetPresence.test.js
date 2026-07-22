const test = require('node:test');
const assert = require('node:assert/strict');
const { computeFleetPresence, normalizeMobileKey } = require('../lib/fleetPresence');

test('normalizeMobileKey unifica mayúsculas y acentos', () => {
  assert.equal(normalizeMobileKey('  Móvil 12 '), 'movil 12');
});

test('computeFleetPresence: último ingreso = adentro, egreso = afuera', () => {
  const mobiles = [
    { id: '1', name: 'Unidad A', plate: 'ABC123' },
    { id: '2', name: 'Unidad B', plate: 'XYZ999' },
    { id: '3', name: 'Unidad C' }
  ];
  const entries = [
    { id: 'e1', type: 'flota', mobile: 'Unidad A', movementType: 'ingreso', timestamp: '2026-07-22T12:00:00Z' },
    { id: 'e2', type: 'flota', mobile: 'Unidad B', movementType: 'egreso', timestamp: '2026-07-22T11:00:00Z' },
    { id: 'e0', type: 'flota', mobile: 'Unidad A', movementType: 'egreso', timestamp: '2026-07-22T10:00:00Z' }
  ];
  const result = computeFleetPresence({ mobiles, entries });
  assert.equal(result.inside, 1);
  assert.equal(result.outside, 2);
  const a = result.mobiles.find((m) => m.name === 'Unidad A');
  assert.equal(a.state, 'inside');
  assert.equal(a.lastMovementType, 'ingreso');
  const b = result.mobiles.find((m) => m.name === 'Unidad B');
  assert.equal(b.state, 'outside');
  const c = result.mobiles.find((m) => m.name === 'Unidad C');
  assert.equal(c.state, 'outside');
});

test('computeFleetPresence: GPS legacy vehiculo cuenta como flota', () => {
  const result = computeFleetPresence({
    mobiles: [{ id: '1', name: 'Blindado 1' }],
    entries: [
      { type: 'vehiculo', gpsAuto: true, mobile: 'Blindado 1', movementType: 'ingreso' }
    ]
  });
  assert.equal(result.inside, 1);
  assert.equal(result.outside, 0);
});
