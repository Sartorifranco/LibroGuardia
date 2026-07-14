const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeExpiryYmd,
  evaluateExpiry,
  buildExpiryMessage
} = require('../lib/documentExpiry');

test('normalizeExpiryYmd ignora vacíos e inválidos', () => {
  assert.equal(normalizeExpiryYmd(null), null);
  assert.equal(normalizeExpiryYmd(''), null);
  assert.equal(normalizeExpiryYmd('no-fecha'), null);
  assert.equal(normalizeExpiryYmd('2026-08-01'), '2026-08-01');
});

test('evaluateExpiry no alerta si no hay fecha (sin falsos vencidos)', () => {
  assert.equal(evaluateExpiry(null, '2026-07-14'), null);
  assert.equal(evaluateExpiry('', '2026-07-14'), null);
  assert.equal(evaluateExpiry('fecha-rara', '2026-07-14'), null);
});

test('evaluateExpiry clasifica rangos 30/15/7 y vencido', () => {
  assert.equal(evaluateExpiry('2026-07-10', '2026-07-14').bucket, 'expired');
  assert.equal(evaluateExpiry('2026-07-20', '2026-07-14').bucket, 'endingIn7');
  assert.equal(evaluateExpiry('2026-07-28', '2026-07-14').bucket, 'endingIn15');
  assert.equal(evaluateExpiry('2026-08-10', '2026-07-14').bucket, 'endingIn30');
  assert.equal(evaluateExpiry('2026-12-01', '2026-07-14'), null);
});

test('buildExpiryMessage identifica sujeto y tipo', () => {
  const msg = buildExpiryMessage({
    kind: 'art',
    subject: 'Juan Pérez',
    endDate: '2026-07-21',
    daysLeft: 7
  });
  assert.match(msg, /ART/);
  assert.match(msg, /Juan Pérez/);
  assert.match(msg, /7/);
});
