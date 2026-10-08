'use strict';

/** Motor de acceso sobre el snapshot en memoria: tabla dorada + invariantes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, createMemorySnapshot } = require('../lib/accessEngine');
const { buildChunks, door } = require('./accessEngineFixture');
const { runGolden, THU_10, dni } = require('./accessEngineGoldenCases');

const makeSnap = (overrides) => createMemorySnapshot(buildChunks(overrides));

runGolden('motor (memoria)', makeSnap);

const SNAP = makeSnap();

test('motor: no lee el reloj del sistema (mismo resultado con Date.now alterado)', () => {
  const realNow = Date.now;
  try {
    Date.now = () => 0;
    const r = decide({ snap: SNAP, credential: dni('20000003'), doorId: 'D2', at: THU_10, state: {} });
    assert.equal(r.decision, 'grant');
  } finally {
    Date.now = realNow;
  }
});

test('motor: valida entrada', () => {
  assert.throws(() => decide({ snap: SNAP, credential: dni('1'), doorId: 'D1' }), /at/);
  assert.throws(() => decide({ snap: SNAP, credential: dni('1'), doorId: 'D1', at: THU_10, mode: 'x' }), /mode/);
  assert.throws(() => decide({ credential: dni('1'), doorId: 'D1', at: THU_10 }), /snap/);
});

test('motor: unlockSec de la puerta define la duración del pulso', () => {
  const snap = makeSnap({ extraDoors: [door('D7', { unlockSec: 7 })] });
  const r = decide({ snap, credential: dni('20000001'), doorId: 'D7', at: THU_10, state: {} });
  assert.deepEqual(r.actions, [{ type: 'unlock', doorId: 'D7', ms: 7000 }]);
});

test('motor: puerta con lados en forma corta [in, out] (sin áreas → sin APB)', () => {
  const snap = makeSnap({ extraDoors: [{ id: 'D8', sides: ['in'] }], policy: { apbMode: 'hard' } });
  const base = { snap, credential: dni('20000001'), doorId: 'D8', at: THU_10, state: { presence: { ch_all: { areaId: 'planta', ts: THU_10 } } } };
  assert.equal(decide(base).decision, 'grant');
  assert.equal(decide({ ...base, side: 'out' }).reason, 'lado_no_habilitado');
});

test('motor: findCredential con forma de array (compatibilidad)', () => {
  const snap = { ...SNAP, findCredential: (type, hash) => {
    const one = SNAP.findCredential(type, hash);
    return one ? [one] : [];
  } };
  assert.equal(decide({ snap, credential: dni('20000001'), doorId: 'D1', at: THU_10, state: {} }).decision, 'grant');
  assert.equal(decide({ snap, credential: dni('99'), doorId: 'D1', at: THU_10, state: {} }).reason, 'credencial_desconocida');
});
