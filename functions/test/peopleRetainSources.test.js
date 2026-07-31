const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasBiostarSignal,
  hasNominaSignal,
  shouldKeepPerson
} = require('../lib/peopleRetainSources');

describe('peopleRetainSources', () => {
  it('keep por BioStar (huella)', () => {
    assert.equal(hasBiostarSignal({ biometricExternalId: '99' }), true);
    assert.equal(shouldKeepPerson({ biometricExternalId: '99', origen: 'import' }, 'x', new Set()), true);
  });

  it('keep por origen nómina', () => {
    assert.equal(hasNominaSignal({ origen: 'nomina' }, 'a', new Set()), true);
    assert.equal(shouldKeepPerson({ origen: 'nomina' }, 'a', new Set()), true);
  });

  it('keep por personalMaster link', () => {
    const ids = new Set(['p1']);
    assert.equal(shouldKeepPerson({ origen: 'import' }, 'p1', ids), true);
    assert.equal(shouldKeepPerson({ origen: 'import' }, 'p2', ids), false);
  });

  it('no keep basura sin bio ni nómina', () => {
    assert.equal(shouldKeepPerson({
      name: 'Juan Viejo',
      origen: 'import',
      source: 'sync'
    }, 'z', new Set(['other'])), false);
  });
});
