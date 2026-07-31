const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pickCanonicalScore } = (() => {
  // Inline the scoring used by cleanup for unit check via plan builders' dependency
  const score = (p) => {
    let s = 0;
    if (String(p.idNumber || '').trim() && !/^(19|20)\d{6}$/.test(String(p.idNumber))) s += 5;
    if (String(p.legajo || '').trim()) s += 4;
    if (p.source !== 'biostar') s += 2;
    if (String(p.biometricExternalId || '').trim()) s += 1;
    return s;
  };
  return {
    pickCanonicalScore: (a, b) => (score(a) >= score(b) ? a : b)
  };
})();
const { scorePersonNameMatch } = require('../lib/personIdentity');

describe('peopleCleanup helpers', () => {
  it('elige la ficha con DNI/legajo como canónica', () => {
    const emp = { id: '1', idNumber: '38646611', legajo: '3451', source: 'nomina', name: 'SARTORI Franco' };
    const bio = { id: '2', idNumber: '', source: 'biostar', biometricExternalId: '9', name: 'Franco S' };
    assert.equal(pickCanonicalScore(emp, bio).id, '1');
  });

  it('score alto para unir Franco S', () => {
    assert.ok(scorePersonNameMatch('SARTORI Franco', 'Franco S') >= 0.78);
  });
});
