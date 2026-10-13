const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

const notes = [];

const user = (role, extra = {}) => ({
  username: extra.username || role,
  role,
  active: true,
  passwordVersion: 1,
  permissions: [],
  ...extra
});

const tokenFor = (id, role) => signTestToken({ id, role });

// Fechas relativas a hoy: con fechas fijas la solicitud se vence al pasar el día.
const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

const solicitud = (extra = {}) => ({
  tipo: 'temporal',
  persona: { name: 'Ana Pérez', dni: '30111222' },
  empresaId: 'acme',
  destinoId: 'planta',
  desde: isoDay(0),
  hasta: isoDay(2),
  motivo: 'Trabajo en planta',
  ...extra
});

describe('bandeja de autorizaciones', () => {
  let mem;
  let srv;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    notes.length = 0;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          guardia: user('guardia', { email: 'guardia@planta.com', nombre: 'Guardia' }),
          responsable: user('responsable', {
            empresaId: 'acme',
            email: 'resp@acme.com',
            nombre: 'Laura Responsable'
          }),
          otro: user('responsable', {
            username: 'otro',
            empresaId: 'otra',
            email: 'otro@otra.com',
            nombre: 'Otro'
          }),
          jefe: user('supervisor', { email: 'jefe@planta.com', nombre: 'Jefe' })
        },
        empresas: {
          acme: { nombre: 'Acme' },
          otra: { nombre: 'Otra' }
        },
        destinos: {
          planta: { nombre: 'Planta', activo: true, doorIds: ['p1', 'p2'] }
        }
      },
      stubs: {
        'lib/notifications/index.js': {
          notify: async (type, payload) => {
            notes.push({ type, payload });
            return { sent: true };
          },
          notifySafe: (type, payload) => {
            notes.push({ type, payload });
          }
        }
      }
    });
    srv = await startRouters(['routes/accessRequests.js', 'routes/access.js']);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => { notes.length = 0; });

  it('quien pidió no puede aprobar su propia solicitud', async () => {
    const created = await srv.request('POST', '/api/requests', {
      token: tokenFor('responsable', 'responsable'),
      body: solicitud()
    });
    assert.equal(created.status, 201, created.text);
    const denied = await srv.request('POST', `/api/requests/${created.body.request.id}/approve`, {
      token: tokenFor('responsable', 'responsable'),
      body: {}
    });
    assert.equal(denied.status, 403, denied.text);
    assert.match(denied.body.message, /pediste vos/i);
  });

  it('el responsable de otra empresa no la ve ni la aprueba', async () => {
    const created = await srv.request('POST', '/api/requests', {
      token: tokenFor('guardia', 'guardia'),
      body: solicitud({ persona: { name: 'Beto Gómez', dni: '27999888' } })
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.request.id;
    const ajena = await srv.request('GET', '/api/requests?estado=pendiente', {
      token: tokenFor('otro', 'responsable')
    });
    assert.equal(ajena.status, 200, ajena.text);
    assert.equal(ajena.body.requests.some((row) => row.id === id), false);
    const denied = await srv.request('POST', `/api/requests/${id}/approve`, {
      token: tokenFor('otro', 'responsable'),
      body: {}
    });
    assert.equal(denied.status, 403, denied.text);
  });

  it('aprobar crea la autorización y marca el compilador', async () => {
    const created = await srv.request('POST', '/api/requests', {
      token: tokenFor('guardia', 'guardia'),
      body: solicitud({ persona: { name: 'Carla Díaz', dni: '33444555' } })
    });
    assert.equal(created.status, 201, created.text);
    assert.match(created.body.message, /Solicitud enviada a Laura Responsable/i);
    assert.equal(notes.some((n) => n.type === 'access_request' && n.payload.extraRecipients.includes('resp@acme.com')), true);
    const id = created.body.request.id;
    const ok = await srv.request('POST', `/api/requests/${id}/approve`, {
      token: tokenFor('responsable', 'responsable'),
      body: { nota: 'Dale' }
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.request.estado, 'aprobada');
    const authId = ok.body.request.grantId;
    assert.ok(authId);
    const auth = mem.getDoc('authorizations', authId);
    assert.equal(auth.active, true);
    assert.equal(auth.type, 'temporal');
    assert.deepEqual(auth.allowedDoorIds, ['p1', 'p2']);
    const dirty = mem.getDoc('sites/principal/compiled', '_dirty');
    assert.ok(Array.isArray(dirty.auths) && dirty.auths.includes(authId));
  });

  it('una visita aprobada queda con pase', async () => {
    const created = await srv.request('POST', '/api/requests', {
      token: tokenFor('guardia', 'guardia'),
      body: solicitud({
        tipo: 'visita',
        persona: { name: 'Diego Ruiz', dni: '25666777' }
      })
    });
    const ok = await srv.request('POST', `/api/requests/${created.body.request.id}/approve`, {
      token: tokenFor('jefe', 'supervisor'),
      body: {}
    });
    assert.equal(ok.status, 200, ok.text);
    const visita = mem.getDoc('visitas', ok.body.request.grantId);
    assert.equal(visita.estado, 'autorizada');
    assert.ok(visita.inviteToken);
    assert.deepEqual(visita.allowedDoorIds, ['p1', 'p2']);
    const dirty = mem.getDoc('sites/principal/compiled', '_dirty');
    assert.ok(Array.isArray(dirty.visitas) && dirty.visitas.includes(ok.body.request.grantId));
  });

  it('si se venció el plazo, al leer queda vencida y no se aprueba', async () => {
    const created = await srv.request('POST', '/api/requests', {
      token: tokenFor('guardia', 'guardia'),
      body: solicitud({
        persona: { name: 'Elena Paz', dni: '20111000' },
        desde: '2026-09-01',
        hasta: '2026-09-02'
      })
    });
    assert.equal(created.status, 201, created.text);
    const listed = await srv.request('GET', '/api/requests?estado=vencida', {
      token: tokenFor('jefe', 'supervisor')
    });
    assert.equal(listed.body.requests.some((row) => row.id === created.body.request.id && row.estado === 'vencida'), true);
    const denied = await srv.request('POST', `/api/requests/${created.body.request.id}/approve`, {
      token: tokenFor('jefe', 'supervisor'),
      body: {}
    });
    assert.equal(denied.status, 400, denied.text);
  });

  it('rechazar exige nota y el solicitante puede cancelar', async () => {
    const created = await srv.request('POST', '/api/requests', {
      token: tokenFor('guardia', 'guardia'),
      body: solicitud({ persona: { name: 'Fede Luna', dni: '31222333' } })
    });
    const id = created.body.request.id;
    const sinNota = await srv.request('POST', `/api/requests/${id}/reject`, {
      token: tokenFor('responsable', 'responsable'),
      body: { nota: 'no' }
    });
    assert.equal(sinNota.status, 400, sinNota.text);
    const cancel = await srv.request('POST', `/api/requests/${id}/cancel`, {
      token: tokenFor('guardia', 'guardia')
    });
    assert.equal(cancel.status, 200, cancel.text);
    assert.equal(cancel.body.request.estado, 'cancelada');
  });

  it('la emergencia abre, avisa al jefe y deja la solicitud para revisar', async () => {
    const res = await srv.request('POST', '/api/guard/exceptional-entry', {
      token: tokenFor('guardia', 'guardia'),
      body: {
        name: 'Gabi Sosa',
        idNumber: '28999111',
        reasonCode: 'medico',
        reasonText: 'Se descompuso en el ingreso'
      }
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.alarmType, 'ingreso_emergencia');
    assert.match(res.body.message, /jefe de seguridad/i);
    const alarm = mem.getDoc('sites/principal/alarms', res.body.alarmId);
    assert.equal(alarm.type, 'ingreso_emergencia');
    assert.equal(alarm.state, 'active');
    assert.equal(notes.some((n) => n.type === 'ingreso_emergencia'), true);
    const review = mem.getDoc('accessRequests', res.body.requestId);
    assert.equal(review.estado, 'revision');
  });

  it('el listado no pasa de 50', async () => {
    const res = await srv.request('GET', '/api/requests?limit=500', {
      token: tokenFor('jefe', 'supervisor')
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.limit, 50);
  });
});
