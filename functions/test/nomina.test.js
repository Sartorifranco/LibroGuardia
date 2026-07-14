const test = require('node:test');
const assert = require('node:assert/strict');
const { parseShift, resolveShiftSchedule } = require('../lib/shiftParser');
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

test('evaluateExpectedToday usa turno en Sistemas sin exigir citacion', () => {
  const employee = {
    active: true,
    centroCosto: 'BACAR SA - Sistemas',
    requiresCitacion: true,
    conCitacionRaw: 'SI',
    authorizationPolicy: 'citacion_shift',
    turnoRaw: 'Lu,Ma,Mi,Ju,Vi 08:00 a 17:00',
    shiftSchedule: { daysOfWeek: ['Lu', 'Ma', 'Mi', 'Ju', 'Vi'], timeWindow: { from: '08:00', to: '17:00' } }
  };
  const result = evaluateExpectedToday(employee, { dayCode: 'Lu', citacionesToday: [] });
  assert.equal(result.expected, true);
  assert.equal(result.reason, 'turno_hoy');
  assert.equal(result.entryTime, '08:00');
});

test('evaluateExpectedToday respeta dias del turno fuera de citacion', () => {
  const employee = {
    active: true,
    centroCosto: 'BACAR SA - Sistemas',
    turnoRaw: 'Lu,Ma,Mi,Ju,Vi 08:00 a 17:00',
    shiftSchedule: { daysOfWeek: ['Lu', 'Ma', 'Mi', 'Ju', 'Vi'], timeWindow: { from: '08:00', to: '17:00' } },
    authorizationPolicy: 'permanent_shift'
  };
  const saturday = evaluateExpectedToday(employee, { dayCode: 'Sa', citacionesToday: [] });
  assert.equal(saturday.expected, false);
  assert.equal(saturday.reason, 'fuera_dia_turno');
});

test('resolveShiftSchedule parsea turnoRaw si falta shiftSchedule', () => {
  const shift = resolveShiftSchedule({ turnoRaw: 'Lu,Ma,Mi,Ju,Vi 07:30 a 16:00' });
  assert.deepEqual(shift.daysOfWeek, ['Lu', 'Ma', 'Mi', 'Ju', 'Vi']);
  assert.equal(shift.timeWindow.from, '07:30');
});

test('evaluateExpectedToday exige citacion en Transporte', () => {
  const employee = {
    active: true,
    centroCosto: 'BACAR SA - Transporte',
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

test('isWithinShiftAccessWindow tolera 30 min antes y 15 despues', () => {
  const { isWithinShiftAccessWindow } = require('../lib/normalize');
  const window = { from: '08:00', to: '17:00' };
  const early = new Date('2026-07-07T07:35:00-03:00');
  const late = new Date('2026-07-07T17:10:00-03:00');
  const tooEarly = new Date('2026-07-07T07:20:00-03:00');
  assert.equal(isWithinShiftAccessWindow(window, early), true);
  assert.equal(isWithinShiftAccessWindow(window, late), true);
  assert.equal(isWithinShiftAccessWindow(window, tooEarly), false);
});

test('isSistemasArea detecta centro Sistemas y Grúas', () => {
  const { isSistemasArea, isGruasArea } = require('../lib/centroCostoGroups');
  assert.equal(isSistemasArea('BACAR SA - Sistemas'), true);
  assert.equal(isGruasArea('GRUAS - Transporte, GRUAS - SE'), true);
});
