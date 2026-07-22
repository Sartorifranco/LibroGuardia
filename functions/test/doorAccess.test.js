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
  it('null / undefined / [] = todas las puertas', () => {
    assert.equal(normalizeAllowedDoorIds(null), null);
    assert.equal(normalizeAllowedDoorIds(undefined), null);
    assert.equal(normalizeAllowedDoorIds([]), null);
    assert.equal(isDoorAllowedForIngreso(null, 'puerta-a'), true);
    assert.equal(isDoorAllowedForIngreso([], 'puerta-a'), true);
    assert.equal(isDoorAllowedForIngreso(undefined, 'puerta-a'), true);
  });

  it('lista no vacía solo permite esas puertas', () => {
    assert.equal(isDoorAllowedForIngreso(['puerta-a', 'puerta-b'], 'puerta-a'), true);
    assert.equal(isDoorAllowedForIngreso(['puerta-a'], 'puerta-c'), false);
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

  it('add/remove door list', () => {
    assert.deepEqual(addDoorToAllowedList(null, 'a'), ['a']);
    assert.deepEqual(addDoorToAllowedList(['a'], 'b'), ['a', 'b']);
    assert.equal(removeDoorFromAllowedList(['a'], 'a'), null);
    assert.deepEqual(removeDoorFromAllowedList(['a', 'b'], 'a'), ['b']);
  });
});

describe('decidirAcceso + allowedDoorIds', () => {
  const referenceDate = new Date('2026-07-03T14:30:00-03:00');

  it('(a) sin allowedDoorIds sigue autorizado en cualquier puerta', async () => {
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
    assert.equal(result.authorized, true);
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

  it('(e) credencial/autorización: allowedDoorIds en authorization restringe igual', () => {
    // Misma regla que usa processKioskScan para credential sin person (y auth con lista propia).
    const denied = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: ['puerta-cred-a'],
      doorId: 'puerta-cred-b',
      movementType: 'ingreso'
    });
    assert.equal(denied.authorized, false);
    assert.equal(denied.denialReason, 'puerta_no_autorizada');

    const ok = applyDoorRestrictionForIngreso({
      authorized: true,
      allowedDoorIds: ['puerta-cred-a'],
      doorId: 'puerta-cred-a',
      movementType: 'ingreso'
    });
    assert.equal(ok.authorized, true);
  });
});
