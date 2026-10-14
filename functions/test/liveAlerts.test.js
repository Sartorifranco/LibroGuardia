const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveAlertsFromDocs } = require('../lib/liveAlerts');

test('buildLiveAlertsFromDocs: excepcional reciente aparece', () => {
  const now = Date.parse('2026-07-22T15:00:00Z');
  const alerts = buildLiveAlertsFromDocs({
    nowMs: now,
    exceptionalEntries: [{
      id: 'e1',
      name: 'Juan',
      idNumber: '30111222',
      exceptionalReason: 'Sin citación',
      timestamp: '2026-07-22T14:58:00Z'
    }],
    accessEvents: []
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'exceptional_entry');
  assert.match(alerts[0].id, /^exceptional:/);
});

test('buildLiveAlertsFromDocs: relayError genera falla de puerta', () => {
  const now = Date.parse('2026-07-22T15:00:00Z');
  const alerts = buildLiveAlertsFromDocs({
    nowMs: now,
    doorNamesById: { d1: 'Molinete Norte' },
    accessEvents: [{
      id: 'ev1',
      type: 'authorized',
      doorId: 'd1',
      relayError: 'timeout bridge',
      createdAt: '2026-07-22T14:59:00Z'
    }]
  });
  assert.equal(alerts.some((a) => a.type === 'door_relay_failure'), true);
  assert.match(alerts.find((a) => a.type === 'door_relay_failure').message, /Molinete Norte/);
});

test('buildLiveAlertsFromDocs: denegados bajo umbral no alertan; al umbral sí (id estable por ventana)', () => {
  const now = Date.parse('2026-07-22T15:00:00Z');
  const base = {
    type: 'denied',
    idNumber: '30111222',
    name: 'Ana',
    doorId: 'puerta-a',
    createdAt: '2026-07-22T14:55:00Z'
  };
  const below = buildLiveAlertsFromDocs({
    nowMs: now,
    denialThreshold: 3,
    denialWindowMinutes: 10,
    accessEvents: [
      { ...base, id: '1' },
      { ...base, id: '2' }
    ]
  });
  assert.equal(below.filter((a) => a.type === 'repeated_denials').length, 0);

  const at = buildLiveAlertsFromDocs({
    nowMs: now,
    denialThreshold: 3,
    denialWindowMinutes: 10,
    accessEvents: [
      { ...base, id: '1' },
      { ...base, id: '2' },
      { ...base, id: '3' }
    ]
  });
  const repeated = at.filter((a) => a.type === 'repeated_denials');
  assert.equal(repeated.length, 1);
  assert.match(repeated[0].id, /^repeated:dni:30111222:/);

  // Misma ventana → mismo id (no duplicar en poll sucesivos)
  const again = buildLiveAlertsFromDocs({
    nowMs: now + 1000,
    denialThreshold: 3,
    denialWindowMinutes: 10,
    accessEvents: [
      { ...base, id: '1' },
      { ...base, id: '2' },
      { ...base, id: '3' },
      { ...base, id: '4' }
    ]
  });
  assert.equal(again.find((a) => a.type === 'repeated_denials').id, repeated[0].id);
});

test('buildLiveAlertsFromDocs: identity_verification genera alerta de verificación', () => {
  const now = Date.parse('2026-07-22T15:00:00Z');
  const alerts = buildLiveAlertsFromDocs({
    nowMs: now,
    doorNamesById: { d1: 'Acceso principal' },
    accessEvents: [{
      id: 'ev-id',
      type: 'identity_verification',
      doorId: 'd1',
      name: 'Juan Pérez',
      idNumber: '30111222',
      photoDataUrl: 'data:image/jpeg;base64,abc',
      createdAt: '2026-07-22T14:59:30Z'
    }]
  });
  const identity = alerts.find((a) => a.type === 'identity_verification');
  assert.ok(identity);
  assert.equal(identity.meta.name, 'Juan Pérez');
  assert.equal(identity.meta.photoUrl, 'data:image/jpeg;base64,abc');
});

test('buildLiveAlertsFromDocs: visita del borde en puerta con aviso → visitor_pass (1b)', () => {
  const now = Date.parse('2026-10-14T19:45:00Z');
  const base = {
    type: 'personal',
    tipoMovimiento: 'ingreso',
    entrySource: 'edge',
    timestamp: '2026-10-14T19:41:00Z',
    createdAt: '2026-10-14T19:44:30Z'
  };
  const alerts = buildLiveAlertsFromDocs({
    nowMs: now,
    notifyDoorIds: new Set(['p1']),
    doorNamesById: { p1: 'Ingreso Principal' },
    movementEntries: [
      { ...base, id: 'a', name: 'Juan Visita', doorId: 'p1', visitorKind: 'visita', hostName: 'Ana', edge: { eventId: 'ctl:1' } },
      { ...base, id: 'b', name: 'Otra Visita', doorId: 'p2', visitorKind: 'visita', edge: { eventId: 'ctl:2' } },
      { ...base, id: 'c', name: 'Vieja', doorId: 'p1', visitorKind: 'visita', createdAt: '2026-10-14T19:40:30Z', edge: { eventId: 'ctl:3' } }
    ]
  });
  const visitors = alerts.filter((a) => a.type === 'visitor_pass');
  assert.equal(visitors.length, 1, 'solo la puerta con aviso y llegada reciente');
  assert.equal(visitors[0].id, 'visitor:ctl:1');
  assert.equal(visitors[0].meta.id, 'ctl:1', 'mismo id que el SSE del hub, para no repetir el cartel');
  assert.equal(visitors[0].meta.kind, 'visita');
  assert.equal(visitors[0].meta.doorName, 'Ingreso Principal');
  assert.equal(visitors[0].meta.hostName, 'Ana');
  assert.ok(!alerts.some((a) => a.type === 'movement' && a.meta.entryId === 'a'), 'no duplica con el aviso de movimiento');
});
