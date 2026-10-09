/**
 * Pantalla de equipos (puertas, estanco, bitácora) y consola de alarmas.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

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

describe('Equipos y alarmas de guardia', () => {
  let mem;
  let srv;
  const adminToken = signTestToken({ id: 'admin', role: 'admin', username: 'admin' });
  const guardiaToken = signTestToken({ id: 'guardia', role: 'guardia', username: 'guardia' });
  const monitoreoToken = signTestToken({ id: 'monitoreo', role: 'monitoreo', username: 'monitoreo' });
  const consultaToken = signTestToken({ id: 'consulta', role: 'consulta', username: 'consulta' });

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    const now = Date.now();
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          admin: user('admin'),
          guardia: user('guardia'),
          monitoreo: user('monitoreo'),
          consulta: user('consulta', { permissions: ['alarmas.ver'] })
        },
        settings: {
          doorsConfig: {
            doors: [
              { id: 'exterior', name: 'Exterior', controllerId: 'ctl-viejo' },
              { id: 'interior', name: 'Interior' },
              { id: 'porton', name: 'Portón calle' }
            ],
            airlockGroups: [
              { id: 'estanco-1', name: 'Estanco principal', doorIds: ['exterior', 'interior'], enabled: true }
            ]
          }
        },
        devices: {
          'ctl-viejo': {
            siteId: 'principal',
            kind: 'controller',
            name: 'Portón',
            doorIds: ['exterior'],
            status: 'active',
            lastSeenAt: now - 2 * 60 * 60 * 1000,
            online: false,
            configVersionApplied: 1
          },
          'ctl-malo': {
            siteId: 'principal',
            kind: 'controller',
            name: 'Molinete',
            doorIds: [],
            status: 'active',
            lastSeenAt: now,
            online: true,
            checks: { reader: false, relay: 'ok', credentials: false, clockOffsetMs: 180000 },
            configVersionApplied: 1
          }
        },
        'sites/principal/compiled': {
          head: { version: 3 }
        }
      },
      stubs: {
        'lib/notifications/index.js': { notifySafe: () => {}, onAdminAuditLogged: async () => {} }
      }
    });
    srv = await startRouters(['routes/edge.js']);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => {
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
  });

  const waitDirty = async () => {
    for (let i = 0; i < 20; i += 1) {
      const doc = mem.getDoc('sites/principal/compiled', '_dirty');
      if (doc && doc.doors === true) return doc;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 15));
    }
    return mem.getDoc('sites/principal/compiled', '_dirty');
  };

  it('semáforo: sin conexión, con problemas y versión de configuración', async () => {
    const res = await srv.request('GET', '/api/admin/devices', { token: adminToken });
    assert.equal(res.status, 200, res.text);
    const viejo = res.body.devices.find((d) => d.id === 'ctl-viejo');
    const malo = res.body.devices.find((d) => d.id === 'ctl-malo');
    assert.equal(viejo.health.label, 'Sin conexión');
    assert.match(viejo.health.detail, /Último contacto hace/);
    assert.equal(malo.health.label, 'Con problemas');
    assert.match(malo.health.detail, /Lector desconectado/);
    assert.match(malo.health.detail, /Credenciales inválidas/);
    assert.match(malo.health.detail, /Reloj desfasado/);
    assert.equal(malo.health.configLabel, 'Actualizando…');
    assert.equal(res.body.configVersion, 3);
    assert.ok(res.body.airlocks.some((g) => g.doorIds.includes('exterior') && g.doorIds.includes('interior')));
  });

  it('no parte un estanco y pide confirmación si la puerta ya tiene equipo', async () => {
    const split = await srv.request('POST', '/api/admin/devices', {
      token: adminToken,
      body: { kind: 'controller', name: 'Nuevo', doorIds: ['exterior'] }
    });
    assert.equal(split.status, 400, split.text);
    assert.equal(split.body.code, 'AIRLOCK_SPLIT');
    assert.match(split.body.message, /estanco/i);
    assert.match(split.body.message, /Interior/);

    const move = await srv.request('POST', '/api/admin/devices', {
      token: adminToken,
      body: { kind: 'controller', name: 'Nuevo', doorIds: ['exterior', 'interior'] }
    });
    assert.equal(move.status, 409, move.text);
    assert.equal(move.body.code, 'DOOR_MOVE_CONFIRM');
    assert.match(move.body.message, /Esta puerta pasa del equipo Portón al nuevo/);
    assert.equal(mem.getDoc('settings', 'doorsConfig').doors[0].controllerId, 'ctl-viejo');

    const ok = await srv.request('POST', '/api/admin/devices', {
      token: adminToken,
      body: { kind: 'controller', name: 'Nuevo', doorIds: ['exterior', 'interior'], confirmMoves: true }
    });
    assert.equal(ok.status, 201, ok.text);
    assert.match(ok.body.enrollment.code, /^[A-Z0-9]{8}$/);
    const stored = mem.getDoc('settings', 'doorsConfig').doors;
    const exterior = stored.find((d) => d.id === 'exterior');
    const interior = stored.find((d) => d.id === 'interior');
    assert.equal(exterior.controllerId, ok.body.device.id);
    assert.equal(interior.controllerId, ok.body.device.id);
    assert.deepEqual(mem.getDoc('devices', 'ctl-viejo').doorIds, []);
    assert.deepEqual(mem.getDoc('devices', ok.body.device.id).doorIds, ['exterior', 'interior']);
    const dirty = await waitDirty();
    assert.equal(dirty && dirty.doors, true);

    const pending = (await srv.request('GET', '/api/admin/devices', { token: adminToken }))
      .body.devices.find((d) => d.id === ok.body.device.id);
    assert.equal(pending.health.label, 'Pendiente de instalar');
  });

  it('bitácora paginada: alta y código nuevo', async () => {
    const created = await srv.request('POST', '/api/admin/devices', {
      token: adminToken,
      body: { kind: 'hub', name: 'Central planta' }
    });
    assert.equal(created.status, 201, created.text);
    const again = await srv.request('POST', `/api/admin/devices/${created.body.device.id}/enrollment`, {
      token: adminToken,
      body: {}
    });
    assert.equal(again.status, 201, again.text);
    assert.notEqual(again.body.enrollment.code, created.body.enrollment.code);

    const page1 = await srv.request('GET', `/api/admin/devices/${created.body.device.id}/log?limit=1`, {
      token: adminToken
    });
    assert.equal(page1.status, 200, page1.text);
    assert.equal(page1.body.events.length, 1);
    assert.ok(page1.body.nextCursor);
    const page2 = await srv.request(
      'GET',
      `/api/admin/devices/${created.body.device.id}/log?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      { token: adminToken }
    );
    assert.equal(page2.status, 200, page2.text);
    assert.equal(page2.body.events.length, 1);
    assert.equal(page2.body.nextCursor, null);
    const messages = [...page1.body.events, ...page2.body.events].map((e) => e.message).sort();
    assert.deepEqual(messages, ['Alta del equipo', 'Se generó otro código de instalación']);

    const denied = await srv.request('GET', `/api/admin/devices/${created.body.device.id}/log`, {
      token: guardiaToken
    });
    assert.equal(denied.status, 403);
  });

  it('alarmas: listar y reconocer exige permiso; la nota es obligatoria', async () => {
    const now = Date.now();
    mem.setDoc('sites/principal/alarms', 'al-forzada', {
      type: 'door_forced',
      doorId: 'exterior',
      state: 'active',
      lastTs: now,
      firstTs: now - 1000,
      count: 2,
      siteId: 'principal'
    });
    mem.setDoc('sites/principal/alarms', 'al-estanco', {
      type: 'interlock_violation',
      doorId: 'interior',
      state: 'active',
      lastTs: now - 10,
      firstTs: now - 10,
      count: 1,
      siteId: 'principal'
    });

    const forbidden = await srv.request('GET', '/api/guard/alarms', { token: monitoreoToken });
    assert.equal(forbidden.status, 403);

    const list = await srv.request('GET', '/api/guard/alarms?status=open&limit=50', { token: guardiaToken });
    assert.equal(list.status, 200, list.text);
    const forced = list.body.alerts.find((a) => a.id === 'al-forzada');
    assert.equal(forced.kind, 'alarm');
    assert.equal(forced.type, 'door_forced');
    assert.equal(forced.severity, 'error');
    assert.match(forced.title, /forzada/i);
    assert.match(forced.message, /Exterior/);
    assert.ok(list.body.queriedAt);

    const byDoor = await srv.request('GET', '/api/guard/alarms?doorId=interior', { token: guardiaToken });
    assert.deepEqual(byDoor.body.alerts.map((a) => a.id), ['al-estanco']);

    const short = await srv.request('POST', '/api/guard/alarms/al-forzada/ack', {
      token: guardiaToken,
      body: { note: 'no' }
    });
    assert.equal(short.status, 400);
    assert.match(short.body.message, /3 caracteres/);

    const onlySee = await srv.request('POST', '/api/guard/alarms/al-forzada/ack', {
      token: consultaToken,
      body: { note: 'vi la puerta' }
    });
    assert.equal(onlySee.status, 403);
    const canSee = await srv.request('GET', '/api/guard/alarms?status=open', { token: consultaToken });
    assert.equal(canSee.status, 200);

    const ack = await srv.request('POST', '/api/guard/alarms/al-forzada/ack', {
      token: guardiaToken,
      body: { note: 'vi la puerta' }
    });
    assert.equal(ack.status, 200, ack.text);
    assert.equal(ack.body.ok, true);
    assert.equal(mem.getDoc('sites/principal/alarms', 'al-forzada').ackNote, 'vi la puerta');

    const open = await srv.request('GET', '/api/guard/alarms?status=open', { token: guardiaToken });
    assert.equal(open.body.alerts.some((a) => a.id === 'al-forzada'), false);

    const recent = await srv.request('GET', '/api/guard/alarms?status=recent', { token: guardiaToken });
    assert.equal(recent.body.alerts.some((a) => a.id === 'al-forzada'), true);

    const closed = await srv.request('POST', '/api/guard/alarms/al-estanco/ack', {
      token: guardiaToken,
      body: { note: 'ya quedó normal', close: true }
    });
    assert.equal(closed.body.ok, true);
    assert.equal(mem.getDoc('sites/principal/alarms', 'al-estanco').state, 'closed');
  });
});
