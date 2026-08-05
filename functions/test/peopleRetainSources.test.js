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

  // personalMaster casi no guarda personId (1 de 155 en agosto de 2026): sin el
  // cruce por legajo el asistente daba de baja a 68 empleados de nómina cuya
  // ficha la había creado el puente de citaciones con origen 'import'.
  describe('cruce por legajo', () => {
    const indice = { personIds: new Set(), legajos: new Set(['261', '2946']) };

    it('keep al empleado de nómina que el puente creó con origen import', () => {
      assert.equal(hasNominaSignal({ origen: 'import', legajoNormalized: '261' }, 'sin-link', indice), true);
      assert.equal(shouldKeepPerson({ origen: 'import', legajoNormalized: '261' }, 'sin-link', indice), true);
    });

    it('ignora los ceros a la izquierda del legajo', () => {
      assert.equal(hasNominaSignal({ origen: 'import', legajoNormalized: '000261' }, 'sin-link', indice), true);
      assert.equal(hasNominaSignal({ origen: 'import', legajo: '0002946' }, 'sin-link', indice), true);
    });

    it('no keep si el legajo no está en la nómina', () => {
      assert.equal(shouldKeepPerson({ origen: 'import', legajoNormalized: '99999' }, 'sin-link', indice), false);
    });

    it('no keep si la ficha no tiene legajo', () => {
      assert.equal(shouldKeepPerson({ origen: 'import' }, 'sin-link', indice), false);
      assert.equal(shouldKeepPerson({ origen: 'import', legajoNormalized: '' }, 'sin-link', indice), false);
    });

    it('sigue aceptando el Set de personIds que se usaba antes', () => {
      assert.equal(shouldKeepPerson({ origen: 'import' }, 'p1', new Set(['p1'])), true);
      assert.equal(shouldKeepPerson({ origen: 'import', legajoNormalized: '261' }, 'p9', new Set(['p1'])), false);
    });
  });
});
