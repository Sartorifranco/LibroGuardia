const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

const user = (role, extra = {}) => ({
  username: extra.username || role,
  role,
  active: true,
  passwordVersion: 1,
  permissions: [],
  ...extra
});

const newKeyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  return { publicKey, privateKey, raw, pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};

// Formato del hub (scripts/edge/hub/cloudClient.js tokenSigningPayload).
const signTs = (privateKey, deviceId, ts) => crypto.sign(null, Buffer.from(`mss-edge-token\n${deviceId}\n${ts}`), privateKey).toString('base64');
// Formato legado (todavía aceptado por la nube).
const signTsLegacy = (privateKey, deviceId, ts) => crypto.sign(null, Buffer.from(`${deviceId}.${ts}`), privateKey).toString('base64');

describe('Edge: equipos, enrolamiento y tokens', () => {
  let mem;
  let srv;
  const customTokenCalls = [];
  const adminToken = signTestToken({ id: 'admin', role: 'admin', username: 'admin' });
  const guardiaToken = signTestToken({ id: 'guardia', role: 'guardia', username: 'guardia' });

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: { admin: user('admin'), guardia: user('guardia') }
      },
      stubs: {
        'lib/notifications/index.js': { notifySafe: () => {}, onAdminAuditLogged: async () => {} }
      }
    });
    require('../firestore').admin.auth = () => ({
      createCustomToken: async (uid, claims) => {
        customTokenCalls.push({ uid, claims });
        return `fb-custom-${uid}`;
      }
    });
    srv = await startRouters(['routes/edge.js', 'routes/entries.js']);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => {
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
    customTokenCalls.length = 0;
  });

  const createDevice = async (body) => {
    const res = await srv.request('POST', '/api/admin/devices', { token: adminToken, body });
    assert.equal(res.status, 201, res.text);
    return res.body;
  };

  const enroll = async (code, keys, kind = 'hub', headers = {}) => srv.request('POST', '/api/edge/v1/enroll', {
    body: { code, publicKey: keys.raw, kind, hostname: 'pc-banco' },
    headers
  });

  const tokenRequest = (deviceId, keys, refreshToken, ts = Date.now()) => srv.request('POST', '/api/edge/v1/token', {
    body: { deviceId, ts, signature: signTs(keys.privateKey, deviceId, ts), refreshToken }
  });

  it('alta de equipo exige lectores.manage y devuelve código de un uso guardado hasheado', async () => {
    const denied = await srv.request('POST', '/api/admin/devices', {
      token: guardiaToken,
      body: { kind: 'hub', name: 'Hub' }
    });
    assert.equal(denied.status, 403);

    const created = await createDevice({ siteId: 'principal', kind: 'hub', name: 'Hub banco' });
    assert.match(created.enrollment.code, /^[A-Z0-9]{8}$/);
    assert.equal(created.enrollment.expiresInSeconds, 600);
    assert.equal(created.device.status, 'pending');
    const { sha256 } = require('../lib/devices');
    assert.ok(mem.hasDoc('deviceEnrollCodes', sha256(created.enrollment.code)));
    assert.equal(mem.hasDoc('deviceEnrollCodes', created.enrollment.code), false);

    const bad = await srv.request('POST', '/api/admin/devices', { token: adminToken, body: { kind: 'kiosk', name: 'x' } });
    assert.equal(bad.status, 400);
  });

  it('enrolamiento feliz: deviceId + refresh (solo se guarda el hash); el código no se reusa', async () => {
    const created = await createDevice({ kind: 'controller', name: 'Pi estanco', doorIds: ['p1', 'p2'] });
    const keys = newKeyPair();
    const res = await enroll(created.enrollment.code, keys, 'controller', { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.deviceId, created.device.id);
    assert.equal(res.body.siteId, 'principal');
    assert.ok(res.body.refreshToken.length >= 40);

    const stored = mem.getDoc('devices', created.device.id);
    assert.equal(stored.status, 'active');
    assert.equal(stored.refreshHash, crypto.createHash('sha256').update(res.body.refreshToken).digest('hex'));
    assert.ok(!JSON.stringify(stored).includes(res.body.refreshToken));
    assert.match(stored.pubKey, /BEGIN PUBLIC KEY/);

    const again = await enroll(created.enrollment.code, newKeyPair(), 'controller', { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(again.status, 400);
    assert.equal(again.body.message, 'Código inválido o expirado');
  });

  it('código vencido → mismo mensaje genérico; tipo distinto → rechazo', async () => {
    const created = await createDevice({ kind: 'hub', name: 'Hub 2' });
    const { sha256 } = require('../lib/devices');
    const id = sha256(created.enrollment.code);
    mem.setDoc('deviceEnrollCodes', id, { ...mem.getDoc('deviceEnrollCodes', id), expiresAt: Date.now() - 1 });
    const expired = await enroll(created.enrollment.code, newKeyPair(), 'hub', { 'x-forwarded-for': '10.0.0.2' });
    assert.equal(expired.status, 400);
    assert.equal(expired.body.message, 'Código inválido o expirado');

    const other = await createDevice({ kind: 'hub', name: 'Hub 3' });
    const wrongKind = await enroll(other.enrollment.code, newKeyPair(), 'controller', { 'x-forwarded-for': '10.0.0.2' });
    assert.equal(wrongKind.status, 400);
    assert.equal(wrongKind.body.code, 'KIND_MISMATCH');
  });

  it('enrolamiento con rate limit por IP (5 fallos → 429)', async () => {
    const headers = { 'x-forwarded-for': '10.9.9.9' };
    let last;
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await enroll('ZZZZZZZZ', newKeyPair(), 'hub', headers);
    }
    assert.equal(last.status, 429);
  });

  it('token: firma + refresh → JWT 1 h de equipo; rota el refresh; replay del viejo rechazado', async () => {
    const created = await createDevice({ kind: 'hub', name: 'Hub token' });
    const keys = newKeyPair();
    const enrolled = (await enroll(created.enrollment.code, keys, 'hub', { 'x-forwarded-for': '10.0.0.3' })).body;

    const first = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.expiresIn, 3600);
    assert.notEqual(first.body.refreshToken, enrolled.refreshToken);
    assert.equal(first.body.firebaseToken, `fb-custom-${enrolled.deviceId}`);
    assert.deepEqual(customTokenCalls[0], {
      uid: enrolled.deviceId,
      claims: { siteId: 'principal', deviceId: enrolled.deviceId, kind: 'hub' }
    });
    const jwt = require('jsonwebtoken');
    const claims = jwt.verify(first.body.token, TEST_JWT_SECRET);
    assert.equal(claims.sub, enrolled.deviceId);
    assert.equal(claims.kind, 'device');
    assert.equal(claims.siteId, 'principal');
    assert.equal(claims.deviceKind, 'hub');
    assert.equal(claims.id, undefined);
    assert.equal(claims.exp - claims.iat, 3600);

    const second0 = await tokenRequest(enrolled.deviceId, keys, first.body.refreshToken);
    assert.equal(second0.status, 200);
    // Primer replay del anterior: gracia (respuesta posiblemente perdida); segundo: reuso real.
    const graceReplay = await tokenRequest(enrolled.deviceId, keys, first.body.refreshToken);
    assert.equal(graceReplay.status, 200);
    const replay = await tokenRequest(enrolled.deviceId, keys, first.body.refreshToken);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'REFRESH_REUSED');
    assert.ok(mem.getDoc('devices', enrolled.deviceId).refreshReuseAt);
    const older = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(older.status, 401);
    const second = graceReplay;

    const wrongKey = await tokenRequest(enrolled.deviceId, newKeyPair(), second.body.refreshToken);
    assert.equal(wrongKey.status, 401);
    assert.equal(wrongKey.body.code, 'BAD_SIGNATURE');

    const skewed = await tokenRequest(enrolled.deviceId, keys, second.body.refreshToken, Date.now() - 5 * 60 * 1000);
    assert.equal(skewed.status, 401);
    assert.equal(skewed.body.code, 'CLOCK_SKEW');
  });

  it('gracia de rotación: respuesta perdida → el anterior sirve UNA vez dentro de 5 min', async () => {
    const created = await createDevice({ kind: 'hub', name: 'Hub gracia' });
    const keys = newKeyPair();
    const enrolled = (await enroll(created.enrollment.code, keys, 'hub', { 'x-forwarded-for': '10.0.0.7' })).body;
    const t1 = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(t1.status, 200);
    // El hub "perdió" t1: vuelve a presentar el refresh del enrolamiento.
    const t2 = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(t2.status, 200, t2.text);
    assert.notEqual(t2.body.refreshToken, t1.body.refreshToken);
    // El refresh perdido (t1) ya no vale; el de t2 sí.
    const lost = await tokenRequest(enrolled.deviceId, keys, t1.body.refreshToken);
    assert.equal(lost.status, 401);
    assert.equal(lost.body.code, 'BAD_REFRESH');
    // La gracia es de una sola vez.
    const again = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(again.status, 401);
    assert.equal(again.body.code, 'REFRESH_REUSED');
    const t3 = await tokenRequest(enrolled.deviceId, keys, t2.body.refreshToken);
    assert.equal(t3.status, 200);
  });

  it('gracia vencida (> 5 min) → REFRESH_REUSED', async () => {
    const created = await createDevice({ kind: 'hub', name: 'Hub gracia vencida' });
    const keys = newKeyPair();
    const enrolled = (await enroll(created.enrollment.code, keys, 'hub', { 'x-forwarded-for': '10.0.0.8' })).body;
    assert.equal((await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken)).status, 200);
    const doc = mem.getDoc('devices', enrolled.deviceId);
    mem.setDoc('devices', enrolled.deviceId, { ...doc, refreshRotatedAt: Date.now() - 6 * 60 * 1000 });
    const late = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(late.status, 401);
    assert.equal(late.body.code, 'REFRESH_REUSED');
  });

  it('firma legada `${deviceId}.${ts}` todavía aceptada', async () => {
    const created = await createDevice({ kind: 'controller', name: 'Pi legado' });
    const keys = newKeyPair();
    const enrolled = (await enroll(created.enrollment.code, keys, 'controller', { 'x-forwarded-for': '10.0.0.9' })).body;
    const ts = Date.now();
    const res = await srv.request('POST', '/api/edge/v1/token', {
      body: { deviceId: enrolled.deviceId, ts, signature: signTsLegacy(keys.privateKey, enrolled.deviceId, ts), refreshToken: enrolled.refreshToken }
    });
    assert.equal(res.status, 200, res.text);
  });

  it('controlador: token sin custom token de Firebase', async () => {
    const created = await createDevice({ kind: 'controller', name: 'Pi' });
    const keys = newKeyPair();
    const enrolled = (await enroll(created.enrollment.code, keys, 'controller', { 'x-forwarded-for': '10.0.0.4' })).body;
    const res = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.firebaseToken, undefined);
    assert.equal(customTokenCalls.length, 0);
  });

  it('token de equipo rechazado en rutas de usuario y token de usuario rechazado en rutas edge', async () => {
    const created = await createDevice({ kind: 'hub', name: 'Hub sep' });
    const keys = newKeyPair();
    const enrolled = (await enroll(created.enrollment.code, keys, 'hub', { 'x-forwarded-for': '10.0.0.5' })).body;
    const deviceToken = (await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken)).body.token;

    const onUser = await srv.request('GET', '/api/entries', { token: deviceToken });
    assert.equal(onUser.status, 401);
    const onAdmin = await srv.request('GET', '/api/admin/devices', { token: deviceToken });
    assert.equal(onAdmin.status, 401);

    const userOnEdge = await srv.request('POST', '/api/edge/v1/heartbeat', { token: adminToken, body: {} });
    assert.equal(userOnEdge.status, 401);
    assert.equal(userOnEdge.body.code, 'DEVICE_TOKEN_REQUIRED');

    const ok = await srv.request('POST', '/api/edge/v1/heartbeat', { token: deviceToken, body: { configVersionApplied: 1 } });
    assert.equal(ok.status, 200, ok.text);
  });

  it('revocar corta el refresh; reemplazar hereda puertas/tipo y marca el viejo', async () => {
    const created = await createDevice({ kind: 'controller', name: 'Pi vieja', doorIds: ['p1', 'p2'] });
    const keys = newKeyPair();
    const enrolled = (await enroll(created.enrollment.code, keys, 'controller', { 'x-forwarded-for': '10.0.0.6' })).body;

    const replaced = await srv.request('POST', `/api/admin/devices/${enrolled.deviceId}/replace`, { token: adminToken, body: {} });
    assert.equal(replaced.status, 201, replaced.text);
    assert.equal(replaced.body.device.kind, 'controller');
    assert.deepEqual(replaced.body.device.doorIds, ['p1', 'p2']);
    assert.equal(replaced.body.device.replacesDeviceId, enrolled.deviceId);
    assert.match(replaced.body.enrollment.code, /^[A-Z0-9]{8}$/);
    const old = mem.getDoc('devices', enrolled.deviceId);
    assert.equal(old.status, 'replaced');
    assert.equal(old.replacedBy, replaced.body.device.id);

    const denied = await tokenRequest(enrolled.deviceId, keys, enrolled.refreshToken);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, 'DEVICE_REVOKED');

    const keys2 = newKeyPair();
    const enrolled2 = (await enroll(replaced.body.enrollment.code, keys2, 'controller', { 'x-forwarded-for': '10.0.0.6' })).body;
    const revoked = await srv.request('POST', `/api/admin/devices/${enrolled2.deviceId}/revoke`, {
      token: adminToken,
      body: { reason: 'robada' }
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.device.status, 'revoked');
    const denied2 = await tokenRequest(enrolled2.deviceId, keys2, enrolled2.refreshToken);
    assert.equal(denied2.status, 401);

    const list = await srv.request('GET', '/api/admin/devices', { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.devices.every((d) => !('refreshHash' in d) && !('pubKey' in d)));
  });
});
