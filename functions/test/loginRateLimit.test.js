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

test('getClientIp usa req.ip (trust proxy) e ignora X-Forwarded-For controlado por el cliente', () => {
  assert.equal(
    getClientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1' }, ip: '10.0.0.1' }),
    '10.0.0.1'
  );
  assert.equal(getClientIp({ headers: {}, ip: '127.0.0.1' }), '127.0.0.1');
  assert.equal(getClientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
});

const makeTxDb = (store) => {
  const ref = (id) => ({
    id,
    async get() {
      const data = store.get(id);
      return { exists: Boolean(data), data: () => (data ? { ...data } : undefined) };
    },
    async set(payload, opts = {}) {
      store.set(id, opts.merge ? { ...(store.get(id) || {}), ...payload } : { ...payload });
    }
  });
  let transactions = 0;
  const db = {
    collection: () => ({ doc: ref }),
    async runTransaction(fn) {
      transactions += 1;
      const writes = [];
      const tx = {
        get: (r) => r.get(),
        set: (r, payload, opts) => writes.push(() => r.set(payload, opts))
      };
      const result = await fn(tx);
      for (const w of writes) await w();
      return result;
    }
  };
  return { db, get transactions() { return transactions; } };
};

test('recordFailedLogin / recordPairingFailure escriben dentro de una transacción', async () => {
  const { recordFailedLogin, recordPairingFailure, userDocId, pairingIpDocId } = require('../lib/loginRateLimit');
  const store = new Map();
  const bag = makeTxDb(store);
  const FieldValue = { serverTimestamp: () => 'TS' };
  const now = 5_000_000;

  for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
    const r = await recordFailedLogin(bag.db, FieldValue, { username: 'guardia', ip: '10.0.0.9' }, now + i);
    assert.equal(r.blocked, false);
  }
  const blocked = await recordFailedLogin(bag.db, FieldValue, { username: 'guardia', ip: '10.0.0.9' }, now + 10);
  assert.equal(blocked.blocked, true);
  assert.equal(store.get(userDocId('guardia')).failedAttempts, MAX_FAILED_ATTEMPTS);
  // usuario + sonda IP por cada intento
  assert.equal(bag.transactions, MAX_FAILED_ATTEMPTS * 2);

  const pairing = await recordPairingFailure(bag.db, FieldValue, { ip: '10.0.0.9' }, now);
  assert.equal(pairing.blocked, false);
  assert.equal(store.get(pairingIpDocId('10.0.0.9')).failedAttempts, 1);
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

test('clearLoginFailures elimina el doc y deja de bloquear', async () => {
  const {
    checkLoginRateLimit,
    clearLoginFailures,
    userDocId
  } = require('../lib/loginRateLimit');
  const now = Date.now();
  const store = new Map();
  store.set(userDocId('kiosk.puerta'), {
    failedAttempts: 5,
    windowStartedAt: now - 1000,
    blockedUntil: now + 60_000
  });
  const db = {
    collection() {
      return {
        doc(id) {
          return {
            async delete() {
              store.delete(id);
            },
            async get() {
              const data = store.get(id);
              return { exists: Boolean(data), data: () => (data ? { ...data } : undefined) };
            }
          };
        }
      };
    }
  };

  const before = await checkLoginRateLimit(db, { username: 'kiosk.puerta' }, now);
  assert.equal(before.blocked, true);

  await clearLoginFailures(db, { username: 'kiosk.puerta' });
  assert.equal(store.has(userDocId('kiosk.puerta')), false);

  const after = await checkLoginRateLimit(db, { username: 'kiosk.puerta' }, now);
  assert.equal(after.blocked, false);
});
