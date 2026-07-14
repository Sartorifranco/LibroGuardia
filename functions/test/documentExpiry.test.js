const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeExpiryYmd,
  evaluateExpiry,
  buildExpiryMessage,
  resolveExpirationAlertScopes,
  filterAlertsByScopes
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

const SAMPLE_ALERTS = [
  { id: 'a1', kind: 'authorization' },
  { id: 'p1', kind: 'art' },
  { id: 'p2', kind: 'license' },
  { id: 'v1', kind: 'insurance' },
  { id: 'v2', kind: 'vtv' }
];

test('scopes: solo entries.view → solo autorizaciones', () => {
  const scopes = resolveExpirationAlertScopes({
    role: 'guardia',
    permissions: ['entries.view']
  });
  assert.deepEqual(scopes, {
    authorizations: true,
    personal: false,
    vehicles: false
  });
  const kinds = filterAlertsByScopes(SAMPLE_ALERTS, scopes).map((a) => a.kind);
  assert.deepEqual(kinds, ['authorization']);
});

test('scopes: personal+vehicles sin entries/citaciones → ART/licencia/seguro/VTV, no autorizaciones', () => {
  const scopes = resolveExpirationAlertScopes({
    role: 'supervisor',
    permissions: ['master.personal.read', 'master.vehicles.read']
  });
  assert.deepEqual(scopes, {
    authorizations: false,
    personal: true,
    vehicles: true
  });
  const kinds = filterAlertsByScopes(SAMPLE_ALERTS, scopes).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['art', 'insurance', 'license', 'vtv']);
});

test('scopes: los tres dominios juntos (como supervisor completo) → todo', () => {
  const scopes = resolveExpirationAlertScopes({
    role: 'supervisor',
    permissions: [
      'entries.view',
      'master.citaciones.read',
      'master.personal.read',
      'master.vehicles.read'
    ]
  });
  assert.deepEqual(scopes, {
    authorizations: true,
    personal: true,
    vehicles: true
  });
  assert.equal(filterAlertsByScopes(SAMPLE_ALERTS, scopes).length, 5);
});

test('scopes: admin ve todos los dominios aunque la lista de permisos venga vacía', () => {
  const scopes = resolveExpirationAlertScopes({ role: 'admin', permissions: [] });
  assert.deepEqual(scopes, {
    authorizations: true,
    personal: true,
    vehicles: true
  });
});
