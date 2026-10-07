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
          cliente: { nombre: 'Cliente SA', activa: true, dominiosPermitidos: ['cliente.com'] }
        },
        destinos: {
          oficinas: { nombre: 'Oficinas', activo: true, doorIds: [] }
        },
        users: {
          'interno.visitas': {
            username: 'interno.visitas',
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

  it('el usuario autoregistrado queda marcado y su visita es pendiente_aprobacion', async () => {
    const reg = await srv.request('POST', '/api/auth/self-register', {
      body: { email: 'nuevo@cliente.com', password: 'ClaveSegura2026!', nombre: 'Nuevo Empleado' }
    });
    assert.equal(reg.status, 201, reg.text);
    const stored = mem.getDoc('users', 'nuevo@cliente.com');
    assert.equal(stored.selfRegistered, true);
    assert.equal(stored.role, 'empleado-visitas');

    const res = await srv.request('POST', '/api/empleado/visitas', {
      token: signTestToken({ id: 'nuevo@cliente.com', role: 'empleado-visitas' }),
      body: visitaBody
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.visita.estado, 'pendiente_aprobacion');
    assert.equal(res.body.visita.inviteToken, null);
  });

  it('autoregistrados legacy (sin flag, con email) también quedan pendientes', async () => {
    mem.setDoc('users', 'viejo@cliente.com', {
      username: 'viejo@cliente.com',
      email: 'viejo@cliente.com',
      role: 'empleado-visitas',
      active: true,
      passwordVersion: 1,
      empresaId: 'cliente'
    });
    const res = await srv.request('POST', '/api/empleado/visitas', {
      token: signTestToken({ id: 'viejo@cliente.com', role: 'empleado-visitas' }),
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
