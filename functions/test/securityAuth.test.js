const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

describe('JWT: algoritmo y secreto', () => {
  let mem;
  let srv;
  const prevSecret = process.env.JWT_SECRET;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: { guardia: user('guardia') }
      }
    });
    srv = await startRouters(['routes/auth.js']);
  });

  after(async () => {
    await srv.close();
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
  });

  it('acepta token HS256 válido', async () => {
    const token = signTestToken({ id: 'guardia', role: 'guardia' });
    const res = await srv.request('GET', '/api/auth/me', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, 'guardia');
  });

  it('rechaza token firmado con otro algoritmo (HS512) aunque el secreto sea correcto', async () => {
    const token = signTestToken({ id: 'guardia', role: 'guardia' }, { algorithm: 'HS512' });
    const res = await srv.request('GET', '/api/auth/me', { token });
    assert.equal(res.status, 401);
  });

  it('rechaza token alg=none', async () => {
    const token = jwt.sign({ id: 'guardia', role: 'admin', passwordVersion: 1 }, null, { algorithm: 'none' });
    const res = await srv.request('GET', '/api/auth/me', { token });
    assert.equal(res.status, 401);
  });

  it('sin JWT_SECRET o con secreto corto responde 500 (no verifica ni firma)', async () => {
    const token = signTestToken({ id: 'guardia', role: 'guardia' });
    delete process.env.JWT_SECRET;
    let res = await srv.request('GET', '/api/auth/me', { token });
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.text, /JWT_SECRET/);

    process.env.JWT_SECRET = 'corto';
    res = await srv.request('GET', '/api/auth/me', { token });
    assert.equal(res.status, 500);

    const { signAuthToken, getJwtSecret } = require('../middleware/auth');
    assert.throws(() => getJwtSecret(), (err) => err.code === 'JWT_SECRET_INVALID');
    assert.throws(() => signAuthToken({ id: 'x' }), (err) => err.code === 'JWT_SECRET_INVALID');
  });

  it('signAuthToken firma con HS256 explícito', () => {
    const { signAuthToken } = require('../middleware/auth');
    const token = signAuthToken({ id: 'guardia' });
    const decoded = jwt.decode(token, { complete: true });
    assert.equal(decoded.header.alg, 'HS256');
  });

  it('login con secreto ausente devuelve 500 genérico sin detalle', async () => {
    mem.setDoc('users', 'login.user', user('guardia', {
      username: 'login.user',
      password: await bcrypt.hash('Clave12345', 4)
    }));
    delete process.env.JWT_SECRET;
    const res = await srv.request('POST', '/api/auth/login', {
      body: { username: 'login.user', password: 'Clave12345' }
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, undefined);
    assert.equal(res.body.token, undefined);
  });
});

describe('Usuarios desactivados / cambio de rol', () => {
  let mem;
  let srv;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          admin: user('admin'),
          'admin.off': user('admin', { username: 'admin.off', active: false }),
          'guardia.off': user('guardia', { username: 'guardia.off', active: false }),
          'guardia.a': user('guardia', { username: 'guardia.a' }),
          'guardia.b': user('guardia', { username: 'guardia.b' })
        }
      }
    });
    srv = await startRouters(['routes/auth.js', 'routes/adminUsersRoles.js', 'routes/entries.js']);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => {
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
  });

  it('rechaza usuario desactivado (rol guardia) con 401 USER_INACTIVE', async () => {
    const token = signTestToken({ id: 'guardia.off', role: 'guardia' });
    const res = await srv.request('GET', '/api/auth/me', { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'USER_INACTIVE');
  });

  it('el rol admin no saltea el chequeo de active', async () => {
    const token = signTestToken({ id: 'admin.off', role: 'admin' });
    const res = await srv.request('GET', '/api/admin/users', { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'USER_INACTIVE');
  });

  it('el cache de passwordVersion también rechaza tras desactivar (sin esperar TTL en esta instancia)', async () => {
    const adminToken = signTestToken({ id: 'admin', role: 'admin' });
    const userToken = signTestToken({ id: 'guardia.a', role: 'guardia' });

    // Calienta el cache con el usuario activo.
    let res = await srv.request('GET', '/api/auth/me', { token: userToken });
    assert.equal(res.status, 200);

    res = await srv.request('PUT', '/api/admin/users/guardia.a', {
      token: adminToken,
      body: { active: false }
    });
    assert.equal(res.status, 200);
    assert.equal(mem.getDoc('users', 'guardia.a').passwordVersion, 2, 'desactivar sube passwordVersion');

    res = await srv.request('GET', '/api/auth/me', { token: userToken });
    assert.equal(res.status, 401);
  });

  it('cambiar el rol sube passwordVersion e invalida el token viejo', async () => {
    const adminToken = signTestToken({ id: 'admin', role: 'admin' });
    const userToken = signTestToken({ id: 'guardia.b', role: 'guardia' });

    let res = await srv.request('PUT', '/api/admin/users/guardia.b', {
      token: adminToken,
      body: { role: 'monitoreo' }
    });
    assert.equal(res.status, 200);
    assert.equal(mem.getDoc('users', 'guardia.b').passwordVersion, 2);

    res = await srv.request('GET', '/api/auth/me', { token: userToken });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /contraseña fue actualizada|sesión/i);

    const fresh = signTestToken({ id: 'guardia.b', role: 'monitoreo', passwordVersion: 2 });
    res = await srv.request('GET', '/api/auth/me', { token: fresh });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/setup/initial-users', () => {
  let mem;
  let srv;
  const prevKey = process.env.SETUP_KEY;
  const SETUP_KEY = 'setup-key-de-prueba-larga-123456';

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          'admin@bacarsa.com.ar': {
            username: 'admin@bacarsa.com.ar',
            role: 'admin',
            active: true,
            password: 'HASH-EXISTENTE',
            passwordVersion: 3
          }
        }
      }
    });
    srv = await startRouters(['routes/auth.js']);
  });

  after(async () => {
    await srv.close();
    if (prevKey === undefined) delete process.env.SETUP_KEY;
    else process.env.SETUP_KEY = prevKey;
  });

  it('sin SETUP_KEY configurada responde 404 (también con la clave default vieja)', async () => {
    delete process.env.SETUP_KEY;
    const res = await srv.request('POST', '/api/setup/initial-users', {
      headers: { 'x-setup-key': 'bacar-lg-setup-2026' },
      body: {}
    });
    assert.equal(res.status, 404);
  });

  it('clave incorrecta → 403', async () => {
    process.env.SETUP_KEY = SETUP_KEY;
    const res = await srv.request('POST', '/api/setup/initial-users', {
      headers: { 'x-setup-key': 'otra-clave' },
      body: {}
    });
    assert.equal(res.status, 403);
  });

  it('nunca devuelve contraseñas, no resetea existentes y crea faltantes con mustChangePassword', async () => {
    process.env.SETUP_KEY = SETUP_KEY;
    const res = await srv.request('POST', '/api/setup/initial-users', {
      headers: { 'x-setup-key': SETUP_KEY },
      body: { force: true }
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /password"\s*:/i);
    const { INITIAL_USERS } = require('../seedUsers');
    INITIAL_USERS.forEach((u) => {
      assert.equal(res.text.includes(u.password), false, 'no debe filtrar contraseñas por defecto');
    });

    const existing = mem.getDoc('users', 'admin@bacarsa.com.ar');
    assert.equal(existing.password, 'HASH-EXISTENTE', 'force no resetea contraseña existente');
    assert.equal(existing.passwordVersion, 3);

    const created = mem.getDoc('users', 'prueba.guardia');
    assert.ok(created, 'crea usuario faltante');
    assert.equal(created.mustChangePassword, true);
    assert.ok(await bcrypt.compare('Guardia123', created.password));

    const adminResult = res.body.results.find((r) => r.username === 'admin@bacarsa.com.ar');
    assert.equal(adminResult.created, false);

    // Sin force, ya ejecutado → 403
    const again = await srv.request('POST', '/api/setup/initial-users', {
      body: { setupKey: SETUP_KEY }
    });
    assert.equal(again.status, 403);
  });
});
