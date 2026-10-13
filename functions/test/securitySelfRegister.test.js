const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

describe('Autoregistro: visitas quedan pendientes de aprobación', () => {
  let mem;
  let srv;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        empresas: {
          cliente: { nombre: 'Bacarsa', activa: true, dominiosPermitidos: ['bacarsa.com.ar'] }
        },
        destinos: {
          oficinas: { nombre: 'Oficinas', activo: true, doorIds: [] }
        },
        users: {
          'interno.visitas': {
            username: 'interno@bacarsa.com.ar',
            role: 'empleado-visitas',
            active: true,
            passwordVersion: 1,
            empresaId: 'cliente'
          }
        }
      }
    });
    srv = await startRouters(['routes/auth.js', 'routes/empleado.js']);
  });

  after(async () => { await srv.close(); });

  const visitaBody = {
    nombreVisitante: 'Ana Gomez',
    dniVisitante: '28999888',
    destinoId: 'oficinas',
    fechaHoraEsperada: '2026-10-08T10:00:00-03:00',
    motivo: 'Reunión'
  };

  it('el autoregistrado queda sin verificar; verificado, su visita es pendiente_aprobacion', async () => {
    const reg = await srv.request('POST', '/api/auth/self-register', {
      body: { email: 'nuevo@bacarsa.com.ar', password: 'ClaveSegura2026!', nombre: 'Nuevo Empleado' }
    });
    assert.equal(reg.status, 201, reg.text);
    const stored = mem.getDoc('users', 'nuevo@bacarsa.com.ar');
    assert.equal(stored.selfRegistered, true);
    assert.equal(stored.role, 'empleado-visitas');
    assert.equal(stored.emailVerified, false);
    assert.match(stored.emailVerifyTokenHash, /^[0-9a-f]{64}$/);

    const token = signTestToken({ id: 'nuevo@bacarsa.com.ar', role: 'empleado-visitas' });
    const denied = await srv.request('POST', '/api/empleado/visitas', { token, body: visitaBody });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'Confirmá tu mail para poder invitar visitas. Revisá tu correo.');

    mem.setDoc('users', 'nuevo@bacarsa.com.ar', { ...stored, emailVerified: true });
    const res = await srv.request('POST', '/api/empleado/visitas', { token, body: visitaBody });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.visita.estado, 'pendiente_aprobacion');
    assert.equal(res.body.visita.inviteToken, null);
  });

  it('autoregistrados legacy (sin flag, con email) también quedan pendientes', async () => {
    mem.setDoc('users', 'viejo@bacarsa.com.ar', {
      username: 'viejo@bacarsa.com.ar',
      email: 'viejo@bacarsa.com.ar',
      role: 'empleado-visitas',
      active: true,
      passwordVersion: 1,
      empresaId: 'cliente'
    });
    const res = await srv.request('POST', '/api/empleado/visitas', {
      token: signTestToken({ id: 'viejo@bacarsa.com.ar', role: 'empleado-visitas' }),
      body: visitaBody
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.visita.estado, 'pendiente_aprobacion');
  });

  it('usuario empleado-visitas creado por un admin sigue autorizando directo', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', {
      token: signTestToken({ id: 'interno.visitas', role: 'empleado-visitas' }),
      body: visitaBody
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.visita.estado, 'autorizada');
  });
});
