const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNameKey,
  normalizeDni,
  isWithinTimeWindow,
  getArgentinaDateParts
} = require('../lib/normalize');
const {
  isPermanentValid,
  isCitacionValid,
  isRangeAuthValid,
  evaluateAuthorizationCandidates,
  TOLERANCIA_MINUTOS
} = require('../lib/accessValidation');

const referenceDate = new Date('2026-07-03T14:30:00-03:00');

test('normalizeDni elimina puntos y espacios', () => {
  assert.equal(normalizeDni('30.461.597'), '30461597');
});

test('buildNameKey ordena tokens alfabéticamente', () => {
  assert.equal(
    buildNameKey('Miguel Angel Fernando', 'Acevedo'),
    'acevedo angel fernando miguel'
  );
});

test('permanente sin daysOfWeek ni timeWindow autoriza siempre', () => {
  const auth = { type: 'permanent', daysOfWeek: null, timeWindow: null };
  assert.equal(isPermanentValid(auth, 'Vi', referenceDate), true);
});

test('permanente con daysOfWeek valida el día correcto', () => {
  const auth = { type: 'permanent', daysOfWeek: ['Lu', 'Ma', 'Mi', 'Ju', 'Vi'], timeWindow: null };
  assert.equal(isPermanentValid(auth, 'Vi', referenceDate), true);
  assert.equal(isPermanentValid(auth, 'Sa', referenceDate), false);
});

test('permanente con timeWindow respeta tolerancia', () => {
  const auth = {
    type: 'permanent',
    daysOfWeek: ['Vi'],
    timeWindow: { from: '08:00', to: '17:00' }
  };
  assert.equal(isPermanentValid(auth, 'Vi', referenceDate), true);

  const fueraDeHorario = new Date('2026-07-03T20:00:00-03:00');
  assert.equal(isPermanentValid(auth, 'Vi', fueraDeHorario), false);
});

test('citacion válida solo para appointmentDate del día', () => {
  const auth = { type: 'citacion', appointmentDate: '2026-07-03', timeWindow: null };
  assert.equal(isCitacionValid(auth, '2026-07-03', referenceDate), true);
  assert.equal(isCitacionValid(auth, '2026-07-04', referenceDate), false);
});

test('visita/temporal válida dentro del rango inclusive', () => {
  const auth = { type: 'visita', startDate: '2026-07-01', endDate: '2026-07-05' };
  assert.equal(isRangeAuthValid(auth, '2026-07-03'), true);
  assert.equal(isRangeAuthValid(auth, '2026-07-06'), false);
});

test('cliente visita un solo día', () => {
  const auth = { type: 'visita', startDate: '2026-07-03', endDate: '2026-07-03' };
  assert.equal(isRangeAuthValid(auth, '2026-07-03'), true);
  assert.equal(isRangeAuthValid(auth, '2026-07-04'), false);
});

test('evaluateAuthorizationCandidates prioriza permanent sobre citacion', () => {
  const result = evaluateAuthorizationCandidates({
    permanentDocs: [{ id: 'p1', type: 'permanent', daysOfWeek: ['Vi'], timeWindow: null }],
    citacionDocs: [{ id: 'c1', type: 'citacion', appointmentDate: '2026-07-03' }],
    rangeDocs: [],
    today: '2026-07-03',
    dayCode: 'Vi',
    referenceDate
  });

  assert.equal(result.authorization.id, 'p1');
  assert.equal(result.denialReason, null);
});

test('sin autorización vigente devuelve sin_citacion_para_hoy', () => {
  const result = evaluateAuthorizationCandidates({
    permanentDocs: [{ id: 'p1', type: 'permanent', daysOfWeek: ['Lu'], timeWindow: null }],
    citacionDocs: [{ id: 'c1', type: 'citacion', appointmentDate: '2026-07-02' }],
    rangeDocs: [],
    today: '2026-07-03',
    dayCode: 'Vi',
    referenceDate
  });

  assert.equal(result.authorization, null);
  assert.equal(result.denialReason, 'sin_citacion_para_hoy');
});

test('isWithinTimeWindow aplica tolerancia configurable', () => {
  const window = { from: '14:45', to: '15:00' };
  assert.equal(isWithinTimeWindow(window, TOLERANCIA_MINUTOS, referenceDate), true);
});

test('getArgentinaDateParts usa zona horaria Argentina', () => {
  const parts = getArgentinaDateParts(referenceDate);
  assert.equal(parts.dateString, '2026-07-03');
  assert.equal(parts.dayCode, 'Vi');
});
