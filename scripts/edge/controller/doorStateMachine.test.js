'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DoorRunner, doorParams, STATES } = require('./doorStateMachine');
const { createFakeClock } = require('./_testkit');

function setup({ door = { unlockSec: 3, heldOpenSec: 10 }, local = {} } = {}) {
  const clock = createFakeClock();
  const effects = [];
  const params = doorParams(door, { inputs: { driver: 'simulated', dps: true, bond: true, rex: true }, ...local });
  const r = new DoorRunner({ doorId: 'p1', params, clock, onEffect: (e) => effects.push(e) });
  // Estado inicial informado por el driver (no genera transiciones)
  r.input('dps', 'closed');
  r.input('bond', 'engaged');
  clock.advance(60);
  const alarms = () => effects.filter((e) => e.type === 'alarm').map((e) => `${e.code}:${e.state}`);
  const events = () => effects.filter((e) => e.type === 'event').map((e) => e.code);
  const outputs = () => effects.filter((e) => e.type === 'output').map((e) => (e.action === 'hold' ? `hold:${e.on}` : e.action));
  return { clock, r, effects, alarms, events, outputs, st: () => r.state.state };
}

describe('máquina de estados de puerta', () => {
  it('grant normal: DESBLOQUEADA → ABIERTA_AUT → cierra → re-traba → SEGURA', () => {
    const t = setup();
    t.r.dispatch({ type: 'unlock', ms: 3000 });
    assert.equal(t.st(), STATES.DESBLOQUEADA);
    t.clock.advance(1500);
    t.r.input('bond', 'released');
    t.r.input('dps', 'open');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.ABIERTA_AUT);
    t.r.input('dps', 'closed');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.outputs(), ['lock']);
    t.r.input('bond', 'engaged');
    t.clock.advance(3000);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.alarms(), []);
    assert.deepEqual(t.events(), ['door_opened', 'door_closed']);
  });

  it('forzada: DPS abre sin grant → FORZADA + door_forced; al cerrar se limpia', () => {
    const t = setup();
    t.r.input('dps', 'open');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.FORZADA);
    assert.deepEqual(t.alarms(), ['door_forced:raised']);
    t.r.input('dps', 'closed');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.alarms(), ['door_forced:raised', 'door_forced:cleared']);
  });

  it('debounce 50 ms: un rebote corto del DPS no genera forzado', () => {
    const t = setup();
    t.r.input('dps', 'open');
    t.clock.advance(20);
    t.r.input('dps', 'closed');
    t.clock.advance(100);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.alarms(), []);
  });

  it('sin heldOpenSec: alarma a los 30 s y se cierra sola al cerrar la puerta', () => {
    assert.equal(doorParams({ unlockSec: 3 }, { inputs: { dps: true } }).heldOpenMs, 30_000);
    assert.equal(doorParams({ heldOpenSec: 12 }, {}).heldOpenMs, 12_000);
    const t = setup({ door: { unlockSec: 3 } });
    t.r.dispatch({ type: 'unlock', ms: 3000 });
    t.r.input('dps', 'open');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.ABIERTA_AUT);
    t.clock.advance(29_000);
    assert.equal(t.st(), STATES.ABIERTA_AUT);
    t.clock.advance(1_000);
    assert.equal(t.st(), STATES.RETENIDA);
    assert.deepEqual(t.alarms(), ['held_open:raised']);
    t.r.input('dps', 'closed');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.alarms(), ['held_open:raised', 'held_open:cleared']);
    assert.deepEqual(t.outputs(), ['lock']);
  });

  it('retenida: abierta más de heldOpenSec → RETENIDA + held_open; se limpia al cerrar', () => {
    const t = setup();
    t.r.dispatch({ type: 'unlock', ms: 3000 });
    t.r.input('dps', 'open');
    t.clock.advance(60);
    t.clock.advance(10_000);
    assert.equal(t.st(), STATES.RETENIDA);
    assert.deepEqual(t.alarms(), ['held_open:raised']);
    t.r.input('dps', 'closed');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.alarms(), ['held_open:raised', 'held_open:cleared']);
  });

  it('re-traba al cerrar con mínimo 1 s desde el unlock', () => {
    const t = setup({ local: { debounceMs: 0 } });
    t.r.dispatch({ type: 'unlock', ms: 3000 });
    t.clock.advance(200);
    t.r.input('dps', 'open');
    t.clock.advance(200);
    t.r.input('dps', 'closed');
    assert.equal(t.st(), STATES.DESBLOQUEADA, 'cerró a los 400 ms: espera');
    assert.deepEqual(t.outputs(), []);
    t.clock.advance(599);
    assert.deepEqual(t.outputs(), []);
    t.clock.advance(1);
    assert.deepEqual(t.outputs(), ['lock']);
    assert.equal(t.st(), STATES.SEGURA);
  });

  it('unlock sin abrir: vuelve a SEGURA y avisa posible bloqueo físico (sin forzado)', () => {
    const t = setup();
    t.r.dispatch({ type: 'unlock', ms: 3000 });
    t.clock.advance(3000);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.events(), ['door_not_opened']);
    assert.deepEqual(t.alarms(), []);
  });

  it('REX enmascara el forzado (salida libre) y con rexUnlocks pulsa la salida', () => {
    const t = setup();
    t.r.input('rex', true);
    t.clock.advance(60);
    t.r.input('rex', false);
    t.r.input('dps', 'open');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.ABIERTA_AUT);
    assert.deepEqual(t.alarms(), []);
    assert.deepEqual(t.outputs(), []);

    const m = setup({ local: { rexUnlocks: true } });
    m.r.input('rex', true);
    m.clock.advance(60);
    assert.equal(m.st(), STATES.DESBLOQUEADA);
    assert.deepEqual(m.outputs(), ['pulse']);
  });

  it('REX vencido: abrir después de la máscara es forzado', () => {
    const t = setup();
    t.r.input('rex', true);
    t.clock.advance(60);
    t.clock.advance(11_000);
    t.r.input('dps', 'open');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.FORZADA);
  });

  it('emergencia: hold desbloqueado sin alarmas de forzado/retenida; al liberar re-traba', () => {
    const t = setup();
    t.r.dispatch({ type: 'emergency', active: true });
    assert.equal(t.st(), STATES.DESBLOQUEADA);
    t.r.input('dps', 'open');
    t.clock.advance(60_000);
    assert.equal(t.st(), STATES.ABIERTA_AUT);
    assert.deepEqual(t.alarms(), ['emergency:raised']);
    t.r.input('dps', 'closed');
    t.clock.advance(60);
    t.r.dispatch({ type: 'emergency', active: false });
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.outputs(), ['hold:true', 'hold:false']);
    assert.deepEqual(t.alarms(), ['emergency:raised', 'emergency:cleared']);
    // un grant durante la emergencia no cambia nada
  });

  it('lock_fault: el bond no traba a los 2 s del re-trabado → FALLA; se recupera al trabar', () => {
    const t = setup();
    t.r.dispatch({ type: 'unlock', ms: 3000 });
    t.r.input('bond', 'released');
    t.clock.advance(1200);
    t.r.input('dps', 'open');
    t.clock.advance(60);
    t.r.input('dps', 'closed');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.SEGURA);
    t.clock.advance(2000);
    assert.equal(t.st(), STATES.FALLA);
    assert.deepEqual(t.alarms(), ['lock_fault:raised']);
    t.r.input('bond', 'engaged');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.SEGURA);
    assert.deepEqual(t.alarms(), ['lock_fault:raised', 'lock_fault:cleared']);
  });

  it('lock_fault: la traba se libera sin orden estando SEGURA', () => {
    const t = setup();
    t.r.input('bond', 'released');
    t.clock.advance(60);
    assert.equal(t.st(), STATES.FALLA);
    assert.equal(t.effects.find((e) => e.type === 'alarm').detail, 'traba_liberada_sin_orden');
  });

  it('sin sensores: unlock vuelve a SEGURA por tiempo, sin eventos de DPS', () => {
    const clock = createFakeClock();
    const effects = [];
    const r = new DoorRunner({ doorId: 'p9', params: doorParams({ unlockSec: 2 }, { inputs: { driver: 'none' } }), clock, onEffect: (e) => effects.push(e) });
    r.dispatch({ type: 'unlock' });
    assert.equal(r.state.state, STATES.DESBLOQUEADA);
    clock.advance(2000);
    assert.equal(r.state.state, STATES.SEGURA);
    assert.deepEqual(effects, []);
  });
});
