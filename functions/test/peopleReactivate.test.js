const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  pickUpsertCandidate,
  buildReactivationFields
} = require('../lib/peopleUpsertMatch');

const doc = (id, data) => ({ id, ref: { id }, data: () => data });

describe('pickUpsertCandidate', () => {
  it('un inactivo con el mismo legajo es el candidato (reactivación)', () => {
    const picked = pickUpsertCandidate(
      [doc('p1', { active: false, legajoNormalized: '26', dniNormalized: '23796878' })],
      { legajoNormalized: '26', dniNormalized: '23796878' }
    );
    assert.equal(picked.status, 'hit');
    assert.equal(picked.candidate.id, 'p1');
  });

  it('si hay activa e inactiva con el mismo legajo, elige la activa', () => {
    const picked = pickUpsertCandidate(
      [
        doc('old', { active: false, legajoNormalized: '26' }),
        doc('live', { active: true, legajoNormalized: '26' })
      ],
      { legajoNormalized: '26' }
    );
    assert.equal(picked.status, 'hit');
    assert.equal(picked.candidate.id, 'live');
  });

  it('ignora perdedores de merge', () => {
    const picked = pickUpsertCandidate(
      [
        doc('loser', { active: false, mergedIntoId: 'p1', legajoNormalized: '26' }),
        doc('p1', { active: false, legajoNormalized: '26' })
      ],
      { legajoNormalized: '26' }
    );
    assert.equal(picked.status, 'hit');
    assert.equal(picked.candidate.id, 'p1');
  });

  it('dos inactivas con el mismo identificador → no elige', () => {
    const picked = pickUpsertCandidate(
      [
        doc('a', { active: false, dniNormalized: '111' }),
        doc('b', { active: false, dniNormalized: '111' })
      ],
      { dniNormalized: '111' }
    );
    assert.equal(picked.status, 'ambiguous');
    assert.equal(picked.reason, 'multiple_inactive');
  });

  it('dos activas → no elige', () => {
    const picked = pickUpsertCandidate(
      [
        doc('a', { active: true, legajoNormalized: '9' }),
        doc('b', { active: true, legajoNormalized: '9' })
      ],
      { legajoNormalized: '9' }
    );
    assert.equal(picked.status, 'ambiguous');
    assert.equal(picked.reason, 'multiple_active');
  });

  it('un inactivo cuyo DNI no coincide con el pedido → no elige', () => {
    const picked = pickUpsertCandidate(
      [doc('p1', { active: false, legajoNormalized: '26', dniNormalized: '111' })],
      { legajoNormalized: '26', dniNormalized: '222' }
    );
    assert.equal(picked.status, 'ambiguous');
    assert.equal(picked.reason, 'dni_conflict');
  });

  it('sin docs → none', () => {
    assert.equal(pickUpsertCandidate([], { legajoNormalized: '1' }).status, 'none');
  });
});

describe('buildReactivationFields', () => {
  it('inactiva + alta → active true y marca de auditoría', () => {
    const patch = buildReactivationFields(
      { active: false },
      { wantActive: true, via: 'nomina', timestamp: 'TS' }
    );
    assert.deepEqual(patch, {
      active: true,
      reactivatedAt: 'TS',
      reactivatedVia: 'nomina'
    });
  });

  it('ya activa → no pisa reactivatedAt', () => {
    assert.deepEqual(
      buildReactivationFields({ active: true }, { wantActive: true, via: 'nomina', timestamp: 'TS' }),
      {}
    );
  });

  it('fila de baja explícita → active false, sin reactivar', () => {
    assert.deepEqual(
      buildReactivationFields({ active: false }, { wantActive: false, via: 'nomina', timestamp: 'TS' }),
      { active: false }
    );
  });
});

describe('findPersonForAccess no reactiva inactivos', () => {
  const firestorePath = require.resolve('../firestore');
  const peoplePath = require.resolve('../people');
  let originalFirestore;

  const installPeopleDb = (onWhere) => {
    require.cache[firestorePath] = {
      id: firestorePath,
      filename: firestorePath,
      loaded: true,
      exports: {
        db: {
          collection(name) {
            assert.equal(name, 'people');
            const chain = {
              where(field, op, value) {
                onWhere({ field, op, value });
                return chain;
              },
              limit() { return chain; },
              async get() {
                return { empty: true, docs: [] };
              }
            };
            return chain;
          }
        },
        FieldValue: { serverTimestamp: () => 'TS' }
      }
    };
    delete require.cache[peoplePath];
    return require('../people');
  };

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
  });

  afterEach(() => {
    delete require.cache[peoplePath];
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
  });

  it('el kiosko sigue pidiendo active == true', async () => {
    const clauses = [];
    const api = installPeopleDb((clause) => clauses.push(clause));
    await api.findPersonForAccess({ idNumber: '23796878', name: '' });
    assert.equal(
      clauses.some((c) => c.field === 'active' && c.value === true),
      true
    );
  });

  it('el upsert de nómina/citaciones NO filtra active', async () => {
    const clauses = [];
    const api = installPeopleDb((clause) => clauses.push(clause));
    await api.findPersonForUpsert({ legajoNormalized: '26' });
    assert.equal(
      clauses.some((c) => c.field === 'active'),
      false
    );
    assert.equal(
      clauses.some((c) => c.field === 'legajoNormalized' && c.value === '26'),
      true
    );
  });
});
