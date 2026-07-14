const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAirlockForOpen } = require('../doorController');

describe('doorController airlock', () => {
  const group = {
    id: 'estanco-1',
    name: 'Ingreso estanco',
    outerCloseDelayMs: 1000,
    interDoorDelayMs: 500,
    transitTimeoutMs: 60000
  };

  const outerDoor = { id: 'ext', name: 'Exterior', airlockRole: 'outer', airlockGroupId: 'estanco-1' };
  const innerDoor = { id: 'int', name: 'Interior', airlockRole: 'inner', airlockGroupId: 'estanco-1' };

  it('permite abrir puerta exterior cuando estanco idle', async () => {
    const result = await evaluateAirlockForOpen({
      door: outerDoor,
      group,
      bypassAirlock: false,
      manual: false
    });
    assert.equal(result.allowed, true);
  });

  it('bloquea interior si exterior sigue abierta', async () => {
    const result = await evaluateAirlockForOpen({
      door: innerDoor,
      group,
      bypassAirlock: false,
      manual: false
    });
    // getAirlockState hits Firestore - in test without emulator may return idle
    // inner with idle should block
    assert.equal(result.allowed, false);
  });

  it('manual bypass permite abrir interior', async () => {
    const result = await evaluateAirlockForOpen({
      door: innerDoor,
      group,
      bypassAirlock: false,
      manual: true
    });
    assert.equal(result.allowed, true);
  });
});
