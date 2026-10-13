'use strict';

/**
 * Una puerta entre dos estancos (caso real: Estanco 2 Playa).
 * Grupo GA: E1P + E2P · Grupo GB: E2P + ISIS + PLAY. En cada estanco, una puerta abierta a la vez.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decide, createMemorySnapshot } = require('../lib/accessEngine');
const { buildChunks, door, side } = require('./accessEngineFixture');
const { THU_10, dni } = require('./accessEngineGoldenCases');

const TIMINGS = { outerCloseDelayMs: 5000, interDoorDelayMs: 2000, transitTimeoutMs: 120000 };
const CERRADA = { state: 'SEGURA', dps: 'closed', bond: 'engaged' };
const ABIERTA = { state: 'ABIERTA_AUT', dps: 'open', bond: 'released' };

const makeSnap = (mode) => {
  const chunks = buildChunks({
    extraDoors: [
      door('E1P', { name: 'Estanco 1 Playa', sides: { in: side('exterior', 'esclusa'), out: side('esclusa', 'exterior') } }),
      door('E2P', { name: 'Estanco 2 Playa', sides: { in: side('esclusa', 'planta'), out: side('planta', 'esclusa') } }),
      door('ISIS', { name: 'Ingreso Sistemas' }),
      door('PLAY', { name: 'Playa' })
    ]
  });
  const timed = mode === 'timed';
  chunks.doors.interlockGroups.push(
    { id: 'GB', doorIds: ['E2P', 'ISIS', 'PLAY'], mode, ...(timed ? { outerDoorId: 'E2P', timings: TIMINGS } : {}) },
    { id: 'GA', doorIds: ['E1P', 'E2P'], mode, ...(timed ? { outerDoorId: 'E1P', timings: TIMINGS } : {}) }
  );
  return createMemorySnapshot(chunks);
};

const scanE2P = (snap, state) => decide({
  snap, credential: dni('20000001'), doorId: 'E2P', side: 'in', at: THU_10, state
});

describe('motor: puerta en dos estancos', () => {
  it('el snapshot devuelve los dos grupos, ordenados por id', () => {
    const snap = makeSnap('sensor');
    assert.deepEqual(snap.interlockGroups('E2P').map((g) => g.id), ['GA', 'GB']);
    assert.equal(snap.interlockGroup('E2P').id, 'GA');
    assert.deepEqual(snap.interlockGroups('PLAY').map((g) => g.id), ['GB']);
    assert.deepEqual(snap.interlockGroups('D1'), []);
  });

  it('sensor: con una puerta del grupo B abierta se niega', () => {
    const r = scanE2P(makeSnap('sensor'), { doorStates: { E1P: CERRADA, ISIS: CERRADA, PLAY: ABIERTA } });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'estanco_esperar');
  });

  it('sensor: con la puerta del grupo A abierta se niega', () => {
    const r = scanE2P(makeSnap('sensor'), { doorStates: { E1P: ABIERTA, ISIS: CERRADA, PLAY: CERRADA } });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'estanco_esperar');
  });

  it('sensor: con todo cerrado se permite', () => {
    const r = scanE2P(makeSnap('sensor'), { doorStates: { E1P: CERRADA, ISIS: CERRADA, PLAY: CERRADA } });
    assert.equal(r.decision, 'grant');
  });

  it('timed: con el grupo B en uso se niega aunque el grupo A habilite', () => {
    const r = scanE2P(makeSnap('timed'), {
      interlock: {
        GA: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 8000, entryDoorId: 'E1P' },
        GB: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 1000, entryDoorId: 'ISIS' }
      }
    });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'estanco_esperar');
  });

  it('timed: con la puerta del grupo A abierta se niega', () => {
    const r = scanE2P(makeSnap('timed'), {
      interlock: { GA: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 1000, entryDoorId: 'E1P' } }
    });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'estanco_esperar');
  });

  it('timed: habilitada en los dos grupos se permite y devuelve un efecto por grupo', () => {
    const r = scanE2P(makeSnap('timed'), {
      interlock: { GA: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 8000, entryDoorId: 'E1P' } }
    });
    assert.equal(r.decision, 'grant');
    assert.equal(r.stateEffects.interlocks.length, 2);
    assert.deepEqual(r.stateEffects.interlocks.map((e) => [e.groupId, e.phase]), [['GA', 'inner_open'], ['GB', 'outer_open']]);
    assert.deepEqual(r.stateEffects.interlock, r.stateEffects.interlocks[0]);
  });

  it('snapshot sin interlockGroups: cae a interlockGroup (un solo grupo)', () => {
    const snap = makeSnap('sensor');
    const legacy = { ...snap, interlockGroups: undefined };
    const r = scanE2P(legacy, { doorStates: { E1P: CERRADA, ISIS: CERRADA, PLAY: ABIERTA } });
    assert.equal(r.decision, 'grant');
  });
});
