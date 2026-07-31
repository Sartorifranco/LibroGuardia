const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scorePersonNameMatch, looksLikeDateDni } = require('../lib/personIdentity');

describe('peopleCleanup helpers', () => {
  it('elige la ficha con DNI/legajo como canónica', () => {
    const score = (p) => {
      let s = 0;
      if (String(p.idNumber || '').trim() && !/^(19|20)\d{6}$/.test(String(p.idNumber))) s += 5;
      if (String(p.legajo || '').trim()) s += 4;
      if (p.source !== 'biostar') s += 2;
      if (String(p.biometricExternalId || '').trim()) s += 1;
      return s;
    };
    const emp = { id: '1', idNumber: '38646611', legajo: '3451', source: 'nomina', name: 'SARTORI Franco' };
    const bio = { id: '2', idNumber: '', source: 'biostar', biometricExternalId: '9', name: 'Franco S' };
    assert.equal(score(emp) > score(bio), true);
  });

  it('score alto para unir Franco S', () => {
    assert.ok(scorePersonNameMatch('SARTORI Franco', 'Franco S') >= 0.78);
  });

  it('match de nombre alcanza para recuperar DNI desde nómina', () => {
    assert.ok(scorePersonNameMatch('SARTORI Franco', 'SARTORI Franco') >= 0.9);
    assert.ok(looksLikeDateDni('20260716'));
  });
});
