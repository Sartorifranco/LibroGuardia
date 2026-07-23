const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockFirestore, installFirestoreMock } = require('./helpers/mockFirestore');

const referenceDate = new Date('2026-07-03T14:30:00-03:00');

test('persona inactiva se deniega sin consultar authorizations', async () => {
  const mock = createMockFirestore({
    people: [{
      id: 'p-inactiva',
      dniNormalized: '11111111',
      nombre: 'Juan Perez',
      nameKey: 'juan perez',
      active: false
    }]
  });

  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.decidirAcceso({
    dni: '11111111',
    nombre: 'Juan',
    apellido: 'Perez',
    tipoMovimiento: 'ingreso',
    referenceDate
  });

  assert.equal(result.authorized, false);
  assert.equal(result.denialReason, 'persona_inactiva');
  assert.equal(mock.authQueries.length, 0);
});

test('persona inactiva se deniega aunque tenga allowedDoorIds', async () => {
  const mock = createMockFirestore({
    people: [{
      id: 'p-inactiva-doors',
      dniNormalized: '22222222',
      nombre: 'Ana Inactiva',
      nameKey: 'ana inactiva',
      active: false,
      allowedDoorIds: ['puerta-p1', 'puerta-p2']
    }],
    authorizations: [{
      id: 'auth-perm',
      personId: 'p-inactiva-doors',
      type: 'permanent',
      active: true
    }]
  });

  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.decidirAcceso({
    dni: '22222222',
    nombre: 'Ana',
    apellido: 'Inactiva',
    tipoMovimiento: 'ingreso',
    doorId: 'puerta-p1',
    referenceDate
  });

  assert.equal(result.authorized, false);
  assert.equal(result.denialReason, 'persona_inactiva');
  assert.equal(mock.authQueries.length, 0);
});

test('resolución por nameKey completa el DNI y autoriza con citación', async () => {
  const mock = createMockFirestore({
    people: [{
      id: 'p-namekey',
      dni: null,
      dniNormalized: null,
      nombre: 'Miguel Angel Fernando Acevedo',
      nameKey: 'acevedo angel fernando miguel',
      active: true
    }],
    authorizations: [{
      id: 'auth-citacion',
      personId: 'p-namekey',
      type: 'citacion',
      appointmentDate: '2026-07-03',
      active: true
    }]
  });

  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.decidirAcceso({
    dni: '30461597',
    nombre: 'Miguel Angel Fernando',
    apellido: 'Acevedo',
    tipoMovimiento: 'ingreso',
    referenceDate
  });

  assert.equal(result.authorized, true);
  assert.equal(result.personId, 'p-namekey');
  assert.equal(mock.peopleUpdates.length, 1);
  assert.equal(mock.peopleUpdates[0].payload.dniNormalized, '30461597');
});

test('persona no encontrada devuelve no_encontrado y validarAcceso escribe entry', async () => {
  const mock = createMockFirestore({
    people: [],
    authorizations: []
  });

  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.validarAcceso({
    dni: '99999999',
    nombre: 'Desconocido',
    apellido: 'Total',
    tipoMovimiento: 'ingreso',
    channel: 'molinete',
    guardId: null
  });

  assert.equal(result.authorized, false);
  assert.equal(result.denialReason, 'no_encontrado');
  assert.equal(result.personId, null);
  assert.equal(result.entryId, 'entry-1');
  assert.equal(mock.entryWrites.length, 1);
  assert.equal(mock.entryWrites[0].authorized, false);
  assert.equal(mock.entryWrites[0].denialReason, 'no_encontrado');
  assert.equal(mock.entryWrites[0].personId, null);
  assert.equal(mock.entryWrites[0].dniSnapshot, '99999999');
});

test('validarAcceso siempre escribe exactamente un entry autorizado', async () => {
  const mock = createMockFirestore({
    people: [{
      id: 'p-sistemas',
      dniNormalized: '12345678',
      nombre: 'Ana Sistemas',
      nameKey: 'ana sistemas',
      active: true
    }],
    authorizations: [{
      id: 'auth-perm',
      personId: 'p-sistemas',
      type: 'permanent',
      active: true,
      daysOfWeek: null,
      timeWindow: null
    }]
  });

  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.validarAcceso({
    dni: '12345678',
    nombre: 'Ana',
    apellido: 'Sistemas',
    tipoMovimiento: 'ingreso',
    channel: 'manual',
    guardId: 'guard-1'
  });

  assert.equal(result.authorized, true);
  assert.equal(result.authorizationType, 'permanent');
  assert.equal(mock.entryWrites.length, 1);
  assert.equal(mock.entryWrites[0].authorized, true);
  assert.equal(mock.entryWrites[0].authorizationId, 'auth-perm');
  assert.equal(mock.entryWrites[0].guardId, 'guard-1');
});
