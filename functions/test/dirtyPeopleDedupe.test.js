const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractRealLegajo,
  planMigration
} = require('../migrate-dedupe-dirty-people');

const ref = (path) => ({ path });
const snapshot = (rows) => ({
  size: rows.length,
  docs: rows.map(({ id, ...data }) => ({
    id,
    ref: ref(`people/${id}`),
    data: () => data
  }))
});
const authSnapshot = (rows) => ({
  size: rows.length,
  docs: rows.map(({ id, ...data }) => ({
    id,
    ref: ref(`authorizations/${id}`),
    data: () => data
  }))
});

describe('migrate-dedupe-dirty-people: plan puro', () => {
  it('extrae el legajo de la fila CSV histórica contaminada', () => {
    const csv = '0026,"Sosa Franco Ariel","Operaciones","Chofer Camion Blindado","06-Jul-2026",640,"",0,1300';
    assert.equal(extractRealLegajo({ legajo: csv, nombre: `Legajo ${csv}` }), '26');
  });

  it('conserva el doc limpio, relinkea autorizaciones y preserva puertas', () => {
    const people = snapshot([
      {
        id: 'clean',
        nombre: 'Sosa Franco Ariel',
        legajoNormalized: '26',
        dniNormalized: '23796878',
        allowedDoorIds: []
      },
      {
        id: 'dirty',
        nombre: 'Legajo 26',
        legajo: '26',
        allowedDoorIds: ['puerta-p1']
      }
    ]);
    const auths = authSnapshot([
      {
        id: 'auth-dirty',
        personId: 'dirty',
        type: 'citacion',
        name: 'Legajo 26',
        legajo: '26'
      }
    ]);

    const plan = planMigration(people, auths);
    assert.equal(plan.duplicateGroups.length, 1);
    assert.equal(plan.duplicateGroups[0].winner.id, 'clean');
    assert.equal(plan.docsToDelete, 1);
    assert.equal(plan.authsToRelink, 1);
    assert.equal(plan.deleteOps[0].ref.path, 'people/dirty');
    assert.deepEqual(plan.winnerPatchOps[0].data.allowedDoorIds, ['puerta-p1']);
    assert.equal(plan.relinkOps[0].data.personId, 'clean');
    assert.equal(plan.relinkOps[0].data.dedupedFromPersonId, 'dirty');
  });

  it('no genera borrados si dos fichas limpias del mismo legajo se contradicen', () => {
    const people = snapshot([
      { id: 'a', nombre: 'Persona Uno', legajo: '77', dni: '11111111' },
      { id: 'b', nombre: 'Persona Dos', legajo: '77', dni: '22222222' }
    ]);

    const plan = planMigration(people, authSnapshot([]));
    assert.equal(plan.ambiguousConflicts.length, 1);
    assert.equal(plan.duplicateGroups.length, 0);
    assert.equal(plan.docsToDelete, 0);
    assert.equal(plan.deleteOps.length, 0);
  });
});
