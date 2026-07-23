const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAllowedDoorIds,
  isDoorAllowedForIngreso,
  applyDoorRestrictionForIngreso,
  addDoorToAllowedList,
  removeDoorFromAllowedList
} = require('../lib/doorAccess');
const { createMockFirestore, installFirestoreMock } = require('./helpers/mockFirestore');

describe('doorAccess helpers', () => {
  it('null / undefined / [] = ninguna puerta (rechazo)', () => {
    assert.deepEqual(normalizeAllowedDoorIds(null), []);
    assert.deepEqual(normalizeAllowedDoorIds(undefined), []);
    assert.deepEqual(normalizeAllowedDoorIds([]), []);
    assert.equal(isDoorAllowedForIngreso(null, 'puerta-a'), false);
    assert.equal(isDoorAllowedForIngreso([], 'puerta-a'), false);
    assert.equal(isDoorAllowedForIngreso(undefined, 'puerta-a'), false);
  });

  it('lista no vacía solo permite esas puertas', () => {
    assert.equal(isDoorAllowedForIngreso(['puerta-a', 'puerta-b'], 'puerta-a'), true);
    assert.equal(isDoorAllowedForIngreso(['puerta-a'], 'puerta-c'), false);
  });

  it('sin doorId en el contexto no aplica restricción', () => {
    assert.equal(isDoorAllowedForIngreso([], null), true);
    assert.equal(isDoorAllowedForIngreso(['a'], ''), true);
  });

  it('applyDoorRestriction: egreso no se restringe', () => {
    const r = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: ['otra'],
      doorId: 'puerta-a',
      movementType: 'egreso'
    });
    assert.equal(r.authorized, true);
  });

  it('applyDoorRestriction: ingreso deniega con puerta_no_autorizada', () => {
    const r = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: ['puerta-b'],
      doorId: 'puerta-a',
      movementType: 'ingreso'
    });
    assert.equal(r.authorized, false);
    assert.equal(r.denialReason, 'puerta_no_autorizada');
    assert.match(r.message, /puerta/i);
  });

  it('applyDoorRestriction: lista vacía deniega ingreso', () => {
    const r = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: [],
      doorId: 'puerta-a',
      movementType: 'ingreso'
    });
    assert.equal(r.authorized, false);
    assert.equal(r.denialReason, 'puerta_no_autorizada');
  });

  it('add/remove door list (vacío = ninguna, no “todas”)', () => {
    assert.deepEqual(addDoorToAllowedList(null, 'a'), ['a']);
    assert.deepEqual(addDoorToAllowedList([], 'a'), ['a']);
    assert.deepEqual(addDoorToAllowedList(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(removeDoorFromAllowedList(['a'], 'a'), []);
    assert.deepEqual(removeDoorFromAllowedList(['a', 'b'], 'a'), ['b']);
  });
});

describe('decidirAcceso + allowedDoorIds', () => {
  const referenceDate = new Date('2026-07-03T14:30:00-03:00');

  it('(a) sin allowedDoorIds rechaza cualquier puerta', async () => {
    const mock = createMockFirestore({
      people: [{
        id: 'p1',
        dniNormalized: '30111222',
        nombre: 'Ana Test',
        nameKey: 'ana test',
        active: true
      }],
      authorizations: [{
        id: 'auth1',
        personId: 'p1',
        type: 'permanent',
        active: true
      }]
    });
    const accessControl = installFirestoreMock(mock);
    const result = await accessControl.decidirAcceso({
      dni: '30111222',
      nombre: 'Ana',
      apellido: 'Test',
      tipoMovimiento: 'ingreso',
      doorId: 'cualquier-puerta',
      referenceDate
    });
    assert.equal(result.authorized, false);
    assert.equal(result.denialReason, 'puerta_no_autorizada');
  });

  it('(b) con lista, rechaza puerta ajena', async () => {
    const mock = createMockFirestore({
      people: [{
        id: 'p2',
        dniNormalized: '30222333',
        nombre: 'Bruno Test',
        nameKey: 'bruno test',
        active: true,
        allowedDoorIds: ['molinete-a']
      }],
      authorizations: [{
        id: 'auth2',
        personId: 'p2',
        type: 'permanent',
        active: true
      }]
    });
    const accessControl = installFirestoreMock(mock);
    const result = await accessControl.decidirAcceso({
      dni: '30222333',
      nombre: 'Bruno',
      apellido: 'Test',
      tipoMovimiento: 'ingreso',
      doorId: 'molinete-b',
      referenceDate
    });
    assert.equal(result.authorized, false);
    assert.equal(result.denialReason, 'puerta_no_autorizada');
  });

  it('(c) con lista, acepta puerta incluida', async () => {
    const mock = createMockFirestore({
      people: [{
        id: 'p3',
        dniNormalized: '30333444',
        nombre: 'Carla Test',
        nameKey: 'carla test',
        active: true,
        allowedDoorIds: ['molinete-a', 'molinete-c']
      }],
      authorizations: [{
        id: 'auth3',
        personId: 'p3',
        type: 'permanent',
        active: true
      }]
    });
    const accessControl = installFirestoreMock(mock);
    const result = await accessControl.decidirAcceso({
      dni: '30333444',
      nombre: 'Carla',
      apellido: 'Test',
      tipoMovimiento: 'ingreso',
      doorId: 'molinete-a',
      referenceDate
    });
    assert.equal(result.authorized, true);
  });

  it('(d) credential/autorización: lista vacía rechaza; lista con puerta acepta', () => {
    const deniedEmpty = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: null,
      doorId: 'puerta-cred-a',
      movementType: 'ingreso'
    });
    assert.equal(deniedEmpty.authorized, false);
    assert.equal(deniedEmpty.denialReason, 'puerta_no_autorizada');

    const deniedWrong = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: ['puerta-cred-a'],
      doorId: 'puerta-cred-b',
      movementType: 'ingreso'
    });
    assert.equal(deniedWrong.authorized, false);
    assert.equal(deniedWrong.denialReason, 'puerta_no_autorizada');

    const ok = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: ['puerta-cred-a'],
      doorId: 'puerta-cred-a',
      movementType: 'ingreso'
    });
    assert.equal(ok.authorized, true);
  });
});
