const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

const user = (role) => ({ username: role, role, active: true, passwordVersion: 1, permissions: [] });

describe('caché de endpoints de guardia', () => {
  let srv;
  const calls = { live: 0, fleet: 0, missing: 0, citados: 0, doors: 0 };

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: { admin: user('admin'), guardia: user('guardia') }
      },
      stubs: {
        'lib/liveAlerts.js': {
          getLiveAlerts: async () => { calls.live += 1; return { alerts: [{ id: `a${calls.live}` }] }; }
        },
        'lib/getFleetPresence.js': {
          getFleetPresence: async () => { calls.fleet += 1; return { inside: 3, outside: 1 }; }
        },
        'attendanceAlerts.js': {
          getMissingAttendanceAlerts: async () => { calls.missing += 1; return { absentCount: 2 }; },
          dismissAttendanceAlert: async () => ({ ok: true }),
          bulkDismissAttendance: async () => ({ ok: true })
        },
        'citadosToday.js': {
          getCitadosToday: async () => { calls.citados += 1; return { expectedCount: 5 }; }
        },
        'doorController.js': {
          openDoor: async () => ({}),
          listActiveDoors: async () => { calls.doors += 1; return { doors: [{ id: 'p1', name: 'P1' }] }; },
          getAirlockState: async () => ({}),
          resetAirlockState: async () => ({}),
          getDoorsPhysicalStatus: async () => ({})
        },
        'lib/doorLastPulse.js': { enrichDoorsWithLastPulse: async (doors) => doors },
        'lib/guardLocalStations.js': { enrichDoorsWithLocalStations: async (doors) => doors },
        'accessControl.js': {
          manualOpenDoor: async () => ({ ok: true }),
          evaluatePersonalAccess: async () => ({}),
          processKioskScan: async () => ({}),
          validarAcceso: async () => ({}),
          triggerAccessIfAuthorized: async () => ({})
        }
      }
    });
    srv = await startRouters(['routes/access.js', 'routes/attendance.js']);
  });

  after(async () => { await srv.close(); });

  const token = () => signTestToken({ id: 'admin', role: 'admin' });

  it('un segundo pedido dentro de los 15 s no vuelve a leer Firestore', async () => {
    for (const path of [
      '/api/guard/live-alerts',
      '/api/guard/fleet-presence',
      '/api/guard/attendance/missing',
      '/api/guard/citados/today',
      '/api/guard/doors'
    ]) {
      const a = await srv.request('GET', path, { token: token() });
      const b = await srv.request('GET', path, { token: token() });
      assert.equal(a.status, 200, `${path} ${a.text}`);
      assert.deepEqual(b.body, a.body);
    }
    assert.deepEqual(calls, { live: 1, fleet: 1, missing: 1, citados: 1, doors: 1 });
  });

  it('pedidos simultáneos comparten una sola lectura', async () => {
    const { getOrCompute } = require('../lib/guardResponseCache');
    let n = 0;
    const slow = () => new Promise((r) => setTimeout(() => { n += 1; r(n); }, 20));
    const [x, y] = await Promise.all([getOrCompute('k-sim', slow), getOrCompute('k-sim', slow)]);
    assert.equal(x, 1);
    assert.equal(y, 1);
    assert.equal(n, 1);
  });

  it('vence a los 15 s y la clave separa query y alcance', async () => {
    const { getOrCompute, buildCacheKey } = require('../lib/guardResponseCache');
    let t = 1000;
    let n = 0;
    const now = () => t;
    const produce = async () => { n += 1; return n; };
    assert.equal(await getOrCompute('k-ttl', produce, { now }), 1);
    t += 14000;
    assert.equal(await getOrCompute('k-ttl', produce, { now }), 1);
    t += 2000;
    assert.equal(await getOrCompute('k-ttl', produce, { now }), 2);
    assert.notEqual(buildCacheKey('/x', { a: 1 }), buildCacheKey('/x', { a: 2 }));
    assert.equal(buildCacheKey('/x', { b: 1, a: 2 }), buildCacheKey('/x', { a: 2, b: 1 }));
    assert.notEqual(buildCacheKey('/x', {}, 'puertas:p1'), buildCacheKey('/x', {}, 'puertas:p2'));
  });

  it('marcar asistencia invalida faltantes y citados', async () => {
    const before = calls.missing;
    await srv.request('POST', '/api/guard/attendance/dismiss', {
      token: token(),
      body: { personId: 'x', reason: 'test' }
    });
    await srv.request('GET', '/api/guard/attendance/missing', { token: token() });
    assert.equal(calls.missing, before + 1);
  });
});
