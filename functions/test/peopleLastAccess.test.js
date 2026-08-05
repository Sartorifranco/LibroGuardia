const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  daysSince,
  matchesAccessFilter,
  serializeLastAccess,
  pickNewerLastAccess
} = require('../lib/peopleLastAccess');

describe('peopleLastAccess', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');

  it('serializeLastAccess y daysSince', () => {
    const row = serializeLastAccess({
      lastAccessAt: new Date('2026-07-04T12:00:00.000Z'),
      lastAccessSource: 'biostar'
    }, now);
    assert.equal(row.daysSinceAccess, 30);
    assert.equal(row.lastAccessSource, 'biostar');
    assert.ok(row.lastAccessAt);
  });

  it('matchesAccessFilter never / unused / stale', () => {
    const never = serializeLastAccess({}, now);
    const mid = serializeLastAccess({ lastAccessAt: new Date('2026-04-01T12:00:00.000Z') }, now);
    assert.equal(matchesAccessFilter(never, 'never', now), true);
    assert.equal(matchesAccessFilter(mid, 'never', now), false);
    assert.equal(matchesAccessFilter(mid, 'unused:90', now), true);
    assert.equal(matchesAccessFilter(never, 'unused:90', now), false);
    assert.equal(matchesAccessFilter(never, 'stale:90', now), true);
  });

  it('pickNewerLastAccess elige el más reciente', () => {
    const keep = { lastAccessAt: new Date('2026-01-01T00:00:00.000Z'), lastAccessSource: 'kiosk' };
    const merge = { lastAccessAt: new Date('2026-06-01T00:00:00.000Z'), lastAccessSource: 'biostar' };
    const picked = pickNewerLastAccess(keep, merge);
    assert.equal(picked.lastAccessSource, 'biostar');
  });

  it('daysSince null sin fecha', () => {
    assert.equal(daysSince(null, now), null);
  });
});
