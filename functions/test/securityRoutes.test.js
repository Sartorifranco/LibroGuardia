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

const tokenFor = (id, role) => signTestToken({ id, role });

describe('Permisos en endpoints de acceso, libro y nómina', () => {
  let mem;
  let srv;
  const triggerCalls = [];
  const kioskCalls = [];

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs({
          operador: ['entries.create', 'entries.view'],
          kiosk_puerta: ['access.kiosk']
        }),
        users: {
          admin: user('admin'),
          guardia: user('guardia'),
          supervisor: user('supervisor'),
          operador: user('operador'),
          empleado: user('empleado-visitas', { email: 'empleado@cliente.com' }),
          'kiosk.p1': user('kiosk_puerta', { permissions: ['access.kiosk'] })
        }
      },
      stubs: {
        'accessControl.js': {
          triggerAccessIfAuthorized: async (args) => {
            triggerCalls.push(args);
            return { authorized: args.allowManualOverride === true, reason: 'test', relay: {} };
          },
          processKioskScan: async (args) => {
            kioskCalls.push(args);
            return { authorized: true, movementType: 'ingreso', door: { id: 'p1' } };
          },
          validarAcceso: async () => ({ autorizado: true }),
          evaluatePersonalAccess: async () => ({ authorized: true }),
          manualOpenDoor: async () => ({ ok: true })
        },
        'lib/guardLocalStations.js': {
          enrichDoorsWithLocalStations: async (doors) => doors
        }
      }
    });
    srv = await startRouters([
      'routes/entries.js',
      'routes/access.js',
      'routes/masterData.js',
      'routes/system.js',
      'routes/fleetGps.js',
      'routes/attendance.js'
    ]);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => {
    triggerCalls.length = 0;
    kioskCalls.length = 0;
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
  });

  const personalEntry = (extra = {}) => ({
    type: 'personal',
    movementType: 'ingreso',
    name: 'Juan Perez',
    idNumber: '30111222',
    entrySource: 'manual',
    ...extra
  });

  it('allowAccessOverride del body se ignora sin access.manual_override / exceptional_entry', async () => {
    const res = await srv.request('POST', '/api/entries', {
      token: tokenFor('operador', 'operador'),
      body: personalEntry({ allowAccessOverride: true })
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(triggerCalls.length, 1);
    assert.notEqual(triggerCalls[0].allowManualOverride, true);
    assert.equal(res.body.entry.accessAuthorized, false);
  });

  it('allowAccessOverride se honra con access.manual_override (supervisor)', async () => {
    const res = await srv.request('POST', '/api/entries', {
      token: tokenFor('supervisor', 'supervisor'),
      body: personalEntry({ allowAccessOverride: true, entrySource: 'scan' })
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(triggerCalls[0].allowManualOverride, true);
  });

  it('allowAccessOverride se honra con access.exceptional_entry (guardia)', async () => {
    const res = await srv.request('POST', '/api/entries', {
      token: tokenFor('guardia', 'guardia'),
      body: personalEntry({ allowAccessOverride: true, entrySource: 'scan' })
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(triggerCalls[0].allowManualOverride, true);
  });

  it('el claim permissions del JWT no otorga override', async () => {
    const token = signTestToken({
      id: 'operador',
      role: 'operador',
      permissions: ['access.manual_override', 'access.exceptional_entry']
    });
    const res = await srv.request('POST', '/api/entries', {
      token,
      body: personalEntry({ allowAccessOverride: true })
    });
    assert.equal(res.status, 201, res.text);
    assert.notEqual(triggerCalls[0].allowManualOverride, true);
  });

  it('POST /api/entries exige entries.create', async () => {
    const res = await srv.request('POST', '/api/entries', {
      token: tokenFor('empleado', 'empleado-visitas'),
      body: personalEntry()
    });
    assert.equal(res.status, 403);
  });

  it('kiosk-scan e ingest: 403 sin access.kiosk', async () => {
    for (const p of ['/api/access/kiosk-scan', '/api/access/ingest']) {
      for (const [id, role] of [['empleado', 'empleado-visitas'], ['operador', 'operador']]) {
        const res = await srv.request('POST', p, {
          token: tokenFor(id, role),
          body: { rawData: '30111222', doorId: 'p1' }
        });
        assert.equal(res.status, 403, `${p} ${role}`);
      }
    }
    assert.equal(kioskCalls.length, 0);
  });

  it('kiosk-scan e ingest: OK para usuario técnico de lector, guardia y admin', async () => {
    for (const [id, role] of [['kiosk.p1', 'kiosk_puerta'], ['guardia', 'guardia'], ['admin', 'admin']]) {
      const res = await srv.request('POST', '/api/access/kiosk-scan', {
        token: tokenFor(id, role),
        body: { rawData: '30111222', doorId: 'p1' }
      });
      assert.equal(res.status, 200, `${role}: ${res.text}`);
    }
    const ingest = await srv.request('POST', '/api/access/ingest', {
      token: tokenFor('kiosk.p1', 'kiosk_puerta'),
      body: { idNumber: '30111222', authMethod: 'dni', doorId: 'p1' }
    });
    assert.equal(ingest.status, 200, ingest.text);
  });

  it('empleado autoregistrado no lee nómina, libro de guardia, personal, búsqueda ni flota', async () => {
    const token = tokenFor('empleado', 'empleado-visitas');
    const checks = [
      ['GET', '/api/entries'],
      ['GET', '/api/master-data/personal'],
      ['POST', '/api/master-data/personal', { name: 'X', idNumber: '1' }],
      ['GET', '/api/search?q=juan'],
      ['GET', '/api/fleet/mobiles'],
      ['GET', '/api/fleet/drivers'],
      ['GET', '/api/nomina/birthdays-today'],
      ['POST', '/api/access/validar', { dni: '30111222' }]
    ];
    for (const [method, p, body] of checks) {
      const res = await srv.request(method, p, { token, body });
      assert.equal(res.status, 403, `${method} ${p}`);
    }
  });

  it('guardia conserva acceso operativo (personal, libro, flota, validar)', async () => {
    const token = tokenFor('guardia', 'guardia');
    for (const [method, p, body] of [
      ['GET', '/api/master-data/personal'],
      ['GET', '/api/fleet/mobiles'],
      ['GET', '/api/fleet/drivers'],
      ['POST', '/api/access/validar', { dni: '30111222' }]
    ]) {
      const res = await srv.request(method, p, { token, body });
      assert.equal(res.status, 200, `${method} ${p}: ${res.text}`);
    }
  });

  it('subida de flota usa fleet.upload (supervisor sí, guardia no)', async () => {
    const body = { data: [{ name: 'Movil 1' }] };
    const denied = await srv.request('POST', '/api/admin/fleet/mobiles/upload', {
      token: tokenFor('guardia', 'guardia'),
      body
    });
    assert.equal(denied.status, 403);
    const ok = await srv.request('POST', '/api/admin/fleet/mobiles/upload', {
      token: tokenFor('supervisor', 'supervisor'),
      body
    });
    assert.equal(ok.status, 200, ok.text);
  });
});

describe('doors-config: secretos enmascarados', () => {
  let mem;
  let srv;
  const BRIDGE_SECRET = 'bridge-secret-super-largo-XY';
  const HTTP_TOKEN = 'http-token-largo-123456-ZW';
  const GLOBAL_SECRET = 'global-bridge-secret-QQ';

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: { admin: user('admin'), guardia: user('guardia') },
        settings: {
          doorsConfig: {
            version: 1,
            defaultDoorId: 'puerta-1',
            doors: [{
              id: 'puerta-1',
              name: 'Puerta 1',
              device: {
                driver: 'generic_http',
                bridgeSecret: BRIDGE_SECRET,
                httpUrl: 'http://10.0.0.5/open',
                httpAuthToken: HTTP_TOKEN
              }
            }],
            airlockGroups: []
          },
          accessControl: { bridgeSecret: GLOBAL_SECRET, bridgeUrl: 'https://bridge' }
        }
      },
      stubs: {
        'lib/guardLocalStations.js': {
          enrichDoorsWithLocalStations: async (doors) => doors
        },
        'lib/accessHardwareCoherence.js': {
          assertDoorsCompatibleWithOfflineLectores: async () => {}
        }
      }
    });
    srv = await startRouters(['routes/access.js']);
  });

  after(async () => { await srv.close(); });

  it('GET enmascara bridgeSecret/httpAuthToken y expone hasX', async () => {
    const res = await srv.request('GET', '/api/admin/doors-config', { token: tokenFor('admin', 'admin') });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text.includes(BRIDGE_SECRET), false);
    assert.equal(res.text.includes(HTTP_TOKEN), false);
    assert.equal(res.text.includes(GLOBAL_SECRET), false);
    const device = res.body.config.doors[0].device;
    assert.equal(device.bridgeSecret, '••••XY');
    assert.equal(device.httpAuthToken, '••••ZW');
    assert.equal(device.hasBridgeSecret, true);
    assert.equal(device.hasHttpAuthToken, true);
    assert.equal(res.body.globalAccess.bridgeSecret, '••••QQ');
    assert.equal(res.body.globalAccess.hasBridgeSecret, true);
  });

  it('PUT con la máscara (o vacío) conserva los secretos guardados', async () => {
    const get = await srv.request('GET', '/api/admin/doors-config', { token: tokenFor('admin', 'admin') });
    const door = get.body.config.doors[0];
    const put = await srv.request('PUT', '/api/admin/doors-config', {
      token: tokenFor('admin', 'admin'),
      body: {
        doors: [{ ...door, name: 'Puerta 1 renombrada', device: { ...door.device, httpAuthToken: '' } }],
        airlockGroups: [],
        defaultDoorId: 'puerta-1',
        globalAccess: { ...get.body.globalAccess }
      }
    });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.text.includes(BRIDGE_SECRET), false);

    const stored = mem.getDoc('settings', 'doorsConfig').doors[0];
    assert.equal(stored.name, 'Puerta 1 renombrada');
    assert.equal(stored.device.bridgeSecret, BRIDGE_SECRET);
    assert.equal(stored.device.httpAuthToken, HTTP_TOKEN);
    assert.equal(stored.device.hasBridgeSecret, undefined, 'no persiste flags de UI');
    assert.equal(mem.getDoc('settings', 'accessControl').bridgeSecret, GLOBAL_SECRET);
  });

  it('PUT con un valor nuevo reemplaza el secreto', async () => {
    const get = await srv.request('GET', '/api/admin/doors-config', { token: tokenFor('admin', 'admin') });
    const door = get.body.config.doors[0];
    const put = await srv.request('PUT', '/api/admin/doors-config', {
      token: tokenFor('admin', 'admin'),
      body: {
        doors: [{ ...door, device: { ...door.device, bridgeSecret: 'nuevo-secreto-123456' } }],
        defaultDoorId: 'puerta-1'
      }
    });
    assert.equal(put.status, 200, put.text);
    const stored = mem.getDoc('settings', 'doorsConfig').doors[0];
    assert.equal(stored.device.bridgeSecret, 'nuevo-secreto-123456');
    assert.equal(stored.device.httpAuthToken, HTTP_TOKEN);
  });

  it('GET /api/guard/doors tampoco expone secretos al guardia', async () => {
    const res = await srv.request('GET', '/api/guard/doors', { token: tokenFor('guardia', 'guardia') });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text.includes(HTTP_TOKEN), false);
    assert.equal(res.text.includes('nuevo-secreto-123456'), false);
  });

  it('GET /api/admin/access-control enmascara bridgeSecret y PUT con máscara lo conserva', async () => {
    const get = await srv.request('GET', '/api/admin/access-control', { token: tokenFor('admin', 'admin') });
    assert.equal(get.status, 200, get.text);
    assert.equal(get.text.includes(GLOBAL_SECRET), false);
    const put = await srv.request('PUT', '/api/admin/access-control', {
      token: tokenFor('admin', 'admin'),
      body: { ...get.body.config, denyMessage: 'Denegado' }
    });
    assert.equal(put.status, 200, put.text);
    const stored = mem.getDoc('settings', 'accessControl');
    assert.equal(stored.bridgeSecret, GLOBAL_SECRET);
    assert.equal(stored.denyMessage, 'Denegado');
    assert.equal(stored.hasBridgeSecret, undefined);
  });
});
