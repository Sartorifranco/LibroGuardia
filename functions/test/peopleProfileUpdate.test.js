const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPersonProfilePatch,
  hasForeignConflict,
  personToAdminJSON
} = require('../lib/peopleProfileUpdate');

describe('peopleProfileUpdate', () => {
  it('rechaza nombre vacío', () => {
    const result = buildPersonProfilePatch({}, { name: '   ', allowedDoorIds: ['puerta-p1'] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.message, /nombre/i);
  });

  it('arma patch con nombre, legajo, dni, activo, notas y puertas', () => {
    const result = buildPersonProfilePatch(
      { nombre: 'Viejo', legajoNormalized: '100' },
      {
        name: 'Guzman Michael',
        legajo: '02854',
        idNumber: '30.123.456',
        active: true,
        notas: '  nota corta  ',
        allowedDoorIds: ['puerta-p1', 'puerta-p2']
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.patch.nombre, 'Guzman Michael');
    assert.equal(result.patch.name, 'Guzman Michael');
    assert.equal(result.patch.legajoNormalized, '2854');
    assert.equal(result.patch.dniNormalized, '30123456');
    assert.equal(result.patch.active, true);
    assert.equal(result.patch.notas, 'nota corta');
    assert.deepEqual(result.patch.allowedDoorIds, ['puerta-p1', 'puerta-p2']);
    assert.ok(result.patch.nameKey);
  });

  it('acepta activo=false vía campo activo', () => {
    const result = buildPersonProfilePatch({}, { activo: false });
    assert.equal(result.ok, true);
    assert.equal(result.patch.active, false);
  });

  it('hasForeignConflict ignora el mismo personId', () => {
    assert.equal(hasForeignConflict([{ id: 'a' }], 'a'), false);
    assert.equal(hasForeignConflict([{ id: 'a' }, { id: 'b' }], 'a'), true);
    assert.equal(hasForeignConflict([], 'a'), false);
  });

  it('personToAdminJSON expone legajo y notas', () => {
    const json = personToAdminJSON({
      id: 'p1',
      data: () => ({
        nombre: 'Test',
        legajoNormalized: '197',
        dniNormalized: '11222333',
        active: true,
        notas: 'hola',
        allowedDoorIds: ['puerta-p1']
      })
    });
    assert.equal(json.legajo, '197');
    assert.equal(json.notas, 'hola');
    assert.equal(json.active, true);
    assert.deepEqual(json.allowedDoorIds, ['puerta-p1']);
  });
});
