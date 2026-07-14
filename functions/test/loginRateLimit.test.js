const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FAILED_ATTEMPTS,
  WINDOW_MS,
  BLOCK_MS,
  LOCKOUT_MESSAGE,
  getClientIp,
  evaluateRateLimitState,
  nextFailureState
} = require('../lib/loginRateLimit');

test('evaluateRateLimitState: ventana vacía o expirada reinicia intentos', () => {
  const now = 1_000_000;
  assert.deepEqual(evaluateRateLimitState(null, now), {
    blocked: false,
    failedAttempts: 0,
    windowExpired: true,
    blockedUntil: null
  });
  assert.equal(
    evaluateRateLimitState({
      failedAttempts: 4,
      windowStartedAt: now - WINDOW_MS - 1
    }, now).windowExpired,
    true
  );
});

test('evaluateRateLimitState: respeta bloqueo activo', () => {
  const now = 1_000_000;
  const state = evaluateRateLimitState({
    failedAttempts: 5,
    windowStartedAt: now - 1000,
    blockedUntil: now + 60_000
  }, now);
  assert.equal(state.blocked, true);
  assert.equal(state.blockedUntil, now + 60_000);
});

test('nextFailureState: al 5.º fallo activa bloqueo de 15 min', () => {
  const now = 2_000_000;
  let data = null;
  for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
    data = nextFailureState(data, now + i);
    assert.equal(data.justBlocked, false);
    assert.equal(data.failedAttempts, i);
    assert.equal(data.blockedUntil, null);
  }
  const blocked = nextFailureState(data, now + MAX_FAILED_ATTEMPTS);
  assert.equal(blocked.justBlocked, true);
  assert.equal(blocked.failedAttempts, MAX_FAILED_ATTEMPTS);
  assert.equal(blocked.blockedUntil, now + MAX_FAILED_ATTEMPTS + BLOCK_MS);
});

test('nextFailureState: ventana nueva tras expirar no arrastra intentos viejos', () => {
  const now = 3_000_000;
  const next = nextFailureState({
    failedAttempts: 4,
    windowStartedAt: now - WINDOW_MS - 5,
    blockedUntil: null
  }, now);
  assert.equal(next.failedAttempts, 1);
  assert.equal(next.justBlocked, false);
});

test('getClientIp usa x-forwarded-for', () => {
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '10.0.0.8, 10.0.0.1' } }), '10.0.0.8');
  assert.equal(getClientIp({ headers: {}, ip: '127.0.0.1' }), '127.0.0.1');
});

test('mensaje de bloqueo es el acordado', () => {
  assert.match(LOCKOUT_MESSAGE, /Demasiados intentos fallidos/i);
});

test('bloqueo es por usuario: checkLoginRateLimit ignora IP bloqueada', async () => {
  const { checkLoginRateLimit } = require('../lib/loginRateLimit');
  const now = Date.now();
  const store = {
    user_guardia: {
      failedAttempts: 5,
      windowStartedAt: now - 1000,
      blockedUntil: now + 60_000
    },
    ip_10_0_0_1: {
      kind: 'ip_probe',
      attemptedUsers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      alertActive: true
    }
  };
  const db = {
    collection: () => ({
      doc: (id) => ({
        get: async () => ({
          exists: Boolean(store[id]),
          data: () => store[id]
        })
      })
    })
  };

  const blockedUser = await checkLoginRateLimit(db, { username: 'guardia', ip: '10.0.0.1' }, now);
  assert.equal(blockedUser.blocked, true);

  const otherUser = await checkLoginRateLimit(db, { username: 'supervisor', ip: '10.0.0.1' }, now);
  assert.equal(otherUser.blocked, false, 'otra cuenta en misma IP no debe bloquearse');
});
