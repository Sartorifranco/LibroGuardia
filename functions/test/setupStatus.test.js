'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSetupStatus } = require('../lib/setupStatus');

const ready = {
  companyName: 'Acme',
  areas: [{ id: 'planta', name: 'Planta' }],
  doors: [{ id: 'p1', active: true, sides: { in: { zoneFrom: 'exterior', zoneTo: 'planta' } } }],
  devices: [{ id: 'ctl1', name: 'Portería', status: 'active', online: true }],
  schedules: [{ id: 'sch1', name: 'Oficina' }],
  holidayDates: [{ date: '2026-01-01' }],
  groups: [{ id: 'g1' }],
  peopleWithAccess: [{ id: 'ana' }],
  guardias: [{ id: 'g', active: true }],
  responsables: [{ id: 'r', active: true }],
  notifications: {
    smtp: { host: 'mail.acme.com', from: 'avisos@acme.com' },
    events: { exceptional_entry: { recipients: ['jefe@acme.com'] } }
  },
  lastSimulateAt: null,
  pendingAuthorizations: 2,
  openAlarms: 1
};

test('primeros pasos: vacío queda pendiente y la prueba es opcional', () => {
  const status = computeSetupStatus({}, Date.parse('2026-10-09T12:00:00Z'));
  assert.equal(status.complete, false);
  const byId = Object.fromEntries(status.steps.map((step) => [step.id, step.status]));
  assert.equal(byId.empresa, 'pending');
  assert.equal(byId.lugares, 'pending');
  assert.equal(byId.equipos, 'pending');
  assert.equal(byId.horarios, 'pending');
  assert.equal(byId.probar, 'optional');
  assert.equal(status.progress.total, 9);
});

test('primeros pasos: con datos reales marca hecho y deja la prueba pendiente', () => {
  const status = computeSetupStatus(ready, Date.parse('2026-10-09T12:00:00Z'));
  const byId = Object.fromEntries(status.steps.map((step) => [step.id, step.status]));
  assert.equal(byId.empresa, 'done');
  assert.equal(byId.lugares, 'done');
  assert.equal(byId.equipos, 'done');
  assert.equal(byId.horarios, 'done');
  assert.equal(byId.grupos, 'done');
  assert.equal(byId.personas, 'done');
  assert.equal(byId.usuarios, 'done');
  assert.equal(byId.avisos, 'done');
  assert.equal(byId.probar, 'pending');
  assert.equal(status.complete, false);
  assert.equal(status.board.pendingAuthorizations, 2);
  assert.equal(status.board.openAlarms, 1);
});

test('primeros pasos: la prueba hecha cierra la puesta en marcha', () => {
  const status = computeSetupStatus({ ...ready, lastSimulateAt: 1 }, Date.parse('2026-10-09T12:00:00Z'));
  assert.equal(status.complete, true);
  assert.equal(status.steps.find((step) => step.id === 'probar').status, 'done');
});

test('un equipo apagado no cuenta como en línea y aparece en el tablero', () => {
  const status = computeSetupStatus({
    ...ready,
    devices: [{ id: 'ctl1', name: 'Portería', status: 'active', online: false }]
  });
  assert.equal(status.steps.find((step) => step.id === 'equipos').status, 'pending');
  assert.equal(status.board.devicesProblem[0].name, 'Portería');
});

test('Siempre alcanza como horario, pero faltan los feriados del año', () => {
  const status = computeSetupStatus({ ...ready, schedules: [], holidayDates: [] });
  const step = status.steps.find((item) => item.id === 'horarios');
  assert.equal(step.status, 'pending');
  assert.match(step.what, /Siempre/);
  assert.match(step.detail, /Falta cargar/);
});
