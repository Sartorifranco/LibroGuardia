const test = require('node:test');
const assert = require('node:assert/strict');
const { parseShift } = require('../lib/shiftParser');
const { parseNominaRow, parseAuthPolicy } = require('../lib/nominaParser');
const { evaluateExpectedToday } = require('../attendanceAlerts');

test('parseShift interpreta turno Lu-Vi con horario', () => {
  const shift = parseShift('Lu,Ma,Mi,Ju,Vi 07:30 a 16:00');
  assert.deepEqual(shift.daysOfWeek, ['Lu', 'Ma', 'Mi', 'Ju', 'Vi']);
  assert.equal(shift.timeWindow.from, '07:30');
  assert.equal(shift.timeWindow.to, '16:00');
  assert.equal(shift.valid, true);
});

test('parseShift devuelve invalido para Sin turno', () => {
  const shift = parseShift('Sin turno');
  assert.equal(shift.valid, false);
});

test('parseNominaRow mapea fila de nómina', () => {
  const parsed = parseNominaRow({
    Usuario: 'ACEVEDO Miguel Angel Fernando',
    DNI: 30461597,
    Legajo: 2530,
    Rol: 'Colaborador',
    'C. Costo': 'BACAR SA - Tesorería',
    Turno: 'Lu,Ma,Mi,Ju,Vi 07:30 a 16:00',
    'Con citacion': 'NO',
    'Tipo de autorizacion': 'PERMANENTE dentro del turno'
  });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.idNumberNormalized, '30461597');
  assert.equal(parsed.authorizationPolicy, 'permanent_shift');
  assert.equal(parsed.requiresCitacion, false);
});

test('parseAuthPolicy rechaza filas corruptas sin tipo reconocible', () => {
  assert.equal(parseAuthPolicy('Eliminar Dar de baja Descargar Archivos', 'NO'), null);
});

test('parseAuthPolicy rescata PERMANENTE con basura de exportacion Excel', () => {
  const corrupt = '                PERMANENTE                                                                                                                                                                              Dar de baja                                                                                                                                                                                                                 Eliminar';
  const parsed = parseAuthPolicy(corrupt, 'NO');
  assert.equal(parsed.policy, 'permanent');
  assert.equal(parsed.createPermanent, true);
});

test('evaluateExpectedToday incluye citados de transporte aunque la poliza diga permanente', () => {
  const employee = {
    active: true,
    requiresCitacion: false,
    authorizationPolicy: 'permanent',
    legajoNormalized: '2530',
    idNumberNormalized: '30461597',
    name: 'ACEVEDO Miguel Angel Fernando',
    shiftSchedule: null
  };
  const citacionesToday = [{ legajoNormalized: '2530', name: 'ACEVEDO Miguel Angel Fernando' }];
  const result = evaluateExpectedToday(employee, { dayCode: 'Lu', citacionesToday });
  assert.equal(result.expected, true);
  assert.equal(result.reason, 'citacion_hoy');
});

test('evaluateExpectedToday exige citacion cuando corresponde', () => {
  const employee = {
    active: true,
    requiresCitacion: true,
    idNumberNormalized: '123',
    shiftSchedule: { daysOfWeek: ['Lu', 'Ma', 'Mi', 'Ju', 'Vi'], timeWindow: { from: '08:00', to: '17:00' } },
    authorizationPolicy: 'citacion_shift'
  };
  const withoutCitacion = evaluateExpectedToday(employee, { dayCode: 'Lu', citacionesToday: [] });
  assert.equal(withoutCitacion.expected, false);

  const withCitacion = evaluateExpectedToday(employee, {
    dayCode: 'Lu',
    citacionesToday: [{ idNumberNormalized: '123' }]
  });
  assert.equal(withCitacion.expected, true);
});
