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

test('parseNominaRow mapea Legajos Online (Apellido/Nombre/Área)', () => {
  const parsed = parseNominaRow({
    Legajo: 26,
    Apellido: 'SOSA',
    Nombre: 'Franco Ariel',
    DNI: 23796878,
    CUIL: '20-23796878-7',
    Email: 'francoasosa@hotmail.com',
    Teléfono: 3517070581,
    Áreas: 'Transporte',
    Puestos: 'Chofer',
    'Centros de Costo': 'BACAR SA - Transporte',
    'Fecha Nac.': '17-07-1974',
    Sexo: 'Masculino',
    Estado: 'Activo'
  });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.name, 'SOSA Franco Ariel');
  assert.equal(parsed.idNumberNormalized, '23796878');
  assert.equal(parsed.area, 'Transporte');
  assert.equal(parsed.puesto, 'Chofer');
  assert.equal(parsed.sex, 'Masculino');
  assert.equal(parsed.birthDate, '1974-07-17');
  assert.equal(parsed.requiresCitacion, true);
  assert.equal(parsed.authorizationPolicy, 'citacion_shift');
  assert.deepEqual(parsed.shiftSchedule.daysOfWeek, ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do']);
  assert.equal(parsed.shiftSchedule.timeWindow.from, '08:00');
  assert.equal(parsed.shiftSchedule.timeWindow.to, '17:00');
});

test('parseNominaRow Sistemas queda permanente en turno sin citación', () => {
  const parsed = parseNominaRow({
    Legajo: 100,
    Apellido: 'GUE',
    Nombre: 'Marcos',
    DNI: 30111222,
    Áreas: 'Sistemas',
    Puestos: 'Sistemas',
    'Centros de Costo': 'BACAR SA - Sistemas',
    'Fecha Nac.': '01-01-1990',
    Sexo: 'Masculino',
    Estado: 'Activo'
  });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.requiresCitacion, false);
  assert.equal(parsed.authorizationPolicy, 'permanent_shift');
  assert.equal(parsed.createPermanent, true);
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

test('buildNominaRowFromFields arma fila parseable desde el form admin', () => {
  const { buildNominaRowFromFields } = require('../lib/nominaParser');
  const row = buildNominaRowFromFields({
    name: 'PEREZ Juan',
    idNumber: '30111222',
    legajo: '1001',
    role: 'Colaborador',
    centroCosto: 'BACAR SA - Sistemas',
    turnoRaw: 'Lu,Ma,Mi,Ju,Vi 08:00 a 17:00',
    requiresCitacion: false,
    authorizationPolicy: 'permanent_shift'
  });
  const parsed = parseNominaRow(row);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.authorizationPolicy, 'permanent_shift');
  assert.equal(parsed.idNumberNormalized, '30111222');
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
