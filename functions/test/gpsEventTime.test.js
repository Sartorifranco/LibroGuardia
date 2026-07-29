const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveGpsEventTimeIso } = require('../fleetGps');

describe('resolveGpsEventTimeIso', () => {
  it('usa fixTime del GPS cuando es válido', () => {
    const iso = resolveGpsEventTimeIso(
      { fixTime: '2026-07-29T14:01:22.000Z' },
      '2026-07-29T14:05:00.000Z'
    );
    assert.equal(iso, '2026-07-29T14:01:22.000Z');
  });

  it('cae al momento de detección si no hay hora GPS', () => {
    const fallback = '2026-07-29T14:05:00.000Z';
    assert.equal(resolveGpsEventTimeIso({}, fallback), fallback);
  });
});
