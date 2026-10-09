'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DoorStateReporter } = require('./doorStateReport');
const { createFakeClock } = require('./_testkit');

function reporter(clock, opts = {}) {
  const out = [];
  const r = new DoorStateReporter({
    clock,
    record: (e) => out.push({ ...e, at: clock.now() }),
    ...opts
  });
  return { r, out };
}

describe('publicación de door_state', () => {
  it('transiciones a menos de 200 ms se coalescen en la última', () => {
    const clock = createFakeClock(1000);
    const { r, out } = reporter(clock);
    r.note({ doorId: 'p1', state: 'DESBLOQUEADA', dps: 'closed', bond: 'engaged', since: 1000 });
    clock.advance(40);
    r.note({ doorId: 'p1', state: 'ABIERTA_AUT', dps: 'open', bond: 'released', since: 1040 });
    clock.advance(200);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'door_state');
    assert.equal(out[0].doorId, 'p1');
    assert.deepEqual(out[0].payload, { state: 'ABIERTA_AUT', dps: 'open', bond: 'released', since: 1040 });
    r.stop();
  });

  it('transiciones separadas se publican las dos', () => {
    const clock = createFakeClock(5000);
    const { r, out } = reporter(clock);
    r.note({ doorId: 'p1', state: 'DESBLOQUEADA', dps: 'closed', bond: 'engaged', since: 5000 });
    clock.advance(200);
    r.note({ doorId: 'p1', state: 'SEGURA', dps: 'closed', bond: 'engaged', since: 5200 });
    clock.advance(200);
    assert.deepEqual(out.map((e) => e.payload.state), ['DESBLOQUEADA', 'SEGURA']);
    r.stop();
  });

  it('no supera 5 eventos por segundo y termina en el último estado', () => {
    const clock = createFakeClock(0);
    const { r, out } = reporter(clock, { coalesceMs: 50, maxPerSec: 5 });
    for (let i = 0; i < 12; i += 1) {
      r.note({ doorId: 'p1', state: `S${i}`, dps: null, bond: null, since: clock.now() });
      clock.advance(50);
    }
    clock.advance(2000);
    for (const ev of out) {
      const inWindow = out.filter((o) => o.at <= ev.at && ev.at - o.at < 1000);
      assert.ok(inWindow.length <= 5, `${inWindow.length} eventos en 1 s (t=${ev.at})`);
    }
    assert.ok(out.length >= 6);
    assert.equal(out[out.length - 1].payload.state, 'S11');
    r.stop();
  });
});
