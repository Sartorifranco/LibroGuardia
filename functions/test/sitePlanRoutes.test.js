'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

const smallWebp = `data:image/webp;base64,${Buffer.alloc(300, 7).toString('base64')}`;

describe('plano del predio', () => {
  let mem;
  let srv;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs({ operador: ['entries.view'] }),
        users: {
          admin: { username: 'admin', role: 'admin', active: true, passwordVersion: 1, permissions: [] },
          guardia: { username: 'g', role: 'guardia', active: true, passwordVersion: 1, permissions: [] },
          operador: { username: 'op', role: 'operador', active: true, passwordVersion: 1, permissions: [] }
        },
        settings: {
          doorsConfig: {
            defaultDoorId: 'p1',
            doors: [
              { id: 'p1', name: 'Portón', mapPos: { x: 0.25, y: 0.75 } },
              { id: 'p2', name: 'Oficina' }
            ],
            airlockGroups: []
          }
        }
      },
      stubs: {
        'lib/guardLocalStations.js': {
          enrichDoorsWithLocalStations: async (doors) => doors
        }
      }
    });
    srv = await startRouters(['routes/sitePlan.js', 'routes/access.js']);
  });

  after(async () => { await srv.close(); });

  const admin = () => signTestToken({ id: 'admin', role: 'admin' });
  const guardia = () => signTestToken({ id: 'guardia', role: 'guardia' });
  const operador = () => signTestToken({ id: 'operador', role: 'operador' });

  it('el guardia lee el plano por /api/guard/site-plan; sin permiso de abrir puertas, no', async () => {
    const meta = await srv.request('GET', '/api/guard/site-plan/meta', { token: guardia() });
    assert.equal(meta.status, 200, meta.text);
    assert.deepEqual(meta.body, { version: null });
    const full = await srv.request('GET', '/api/guard/site-plan', { token: guardia() });
    assert.equal(full.status, 200, full.text);
    assert.equal(full.body.plan, null);

    assert.equal((await srv.request('GET', '/api/guard/site-plan')).status, 401);
    assert.equal((await srv.request('GET', '/api/guard/site-plan', { token: operador() })).status, 403);
    assert.equal((await srv.request('GET', '/api/guard/site-plan/meta', { token: operador() })).status, 403);
  });

  it('GET /api/guard/doors incluye mapPos de cada puerta', async () => {
    const res = await srv.request('GET', '/api/guard/doors', { token: guardia() });
    assert.equal(res.status, 200, res.text);
    const byId = Object.fromEntries(res.body.doors.map((d) => [d.id, d]));
    assert.deepEqual(byId.p1.mapPos, { x: 0.25, y: 0.75 });
    assert.equal(byId.p2.mapPos, null);
  });

  it('sin token no se ve el plano', async () => {
    const res = await srv.request('GET', '/api/admin/site-plan');
    assert.equal(res.status, 401);
  });

  it('un guardia no lee ni sube el plano', async () => {
    const read = await srv.request('GET', '/api/admin/site-plan', { token: guardia() });
    assert.equal(read.status, 403);
    const meta = await srv.request('GET', '/api/admin/site-plan/meta', { token: guardia() });
    assert.equal(meta.status, 403);
    const put = await srv.request('PUT', '/api/admin/site-plan', {
      token: guardia(),
      body: { imageDataUrl: smallWebp, width: 800, height: 600 }
    });
    assert.equal(put.status, 403);
  });

  it('sin plano devuelve null', async () => {
    const res = await srv.request('GET', '/api/admin/site-plan', { token: admin() });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.plan, null);
    const meta = await srv.request('GET', '/api/admin/site-plan/meta', { token: admin() });
    assert.equal(meta.body.version, null);
  });

  it('rechaza tipos que no son imagen permitida', async () => {
    for (const imageDataUrl of ['data:image/gif;base64,R0lGOD', 'data:text/plain;base64,aG9sYQ==', 'https://x/y.png', '']) {
      const res = await srv.request('PUT', '/api/admin/site-plan', {
        token: admin(),
        body: { imageDataUrl, width: 800, height: 600 }
      });
      assert.equal(res.status, 400, imageDataUrl);
    }
  });

  it('rechaza imágenes de más de 900 KB y acepta justo 900 KB', () => {
    const { validatePlanBody } = require('../routes/sitePlan')._test;
    const dataUrl = (bytes) => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;
    assert.throws(
      () => validatePlanBody({ imageDataUrl: dataUrl(900 * 1024 + 1), width: 800, height: 600 }),
      (err) => err.status === 400 && /pesada/.test(err.message)
    );
    assert.equal(validatePlanBody({ imageDataUrl: dataUrl(900 * 1024), width: 800, height: 600 }).width, 800);
  });

  it('rechaza medidas fuera de rango', async () => {
    for (const [width, height] of [[99, 600], [800, 8001], [800.5, 600], ['x', 600]]) {
      const res = await srv.request('PUT', '/api/admin/site-plan', {
        token: admin(),
        body: { imageDataUrl: smallWebp, width, height }
      });
      assert.equal(res.status, 400, `${width}x${height}`);
    }
  });

  it('guarda, sube la versión, audita y lo quita', async () => {
    const first = await srv.request('PUT', '/api/admin/site-plan', {
      token: admin(),
      body: { imageDataUrl: smallWebp, width: 800, height: 600 }
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.plan.version, 1);
    const stored = mem.getDoc('sites/principal/plans', 'planta-baja');
    assert.equal(stored.width, 800);

    const second = await srv.request('PUT', '/api/admin/site-plan', {
      token: admin(),
      body: { imageDataUrl: smallWebp, width: 1200, height: 900 }
    });
    assert.equal(second.body.plan.version, 2);

    const meta = await srv.request('GET', '/api/admin/site-plan/meta', { token: admin() });
    assert.deepEqual(meta.body, { version: 2 });
    const full = await srv.request('GET', '/api/admin/site-plan', { token: admin() });
    assert.equal(full.body.plan.imageDataUrl, smallWebp);
    assert.equal(full.body.plan.width, 1200);
    const guardMeta = await srv.request('GET', '/api/guard/site-plan/meta', { token: guardia() });
    assert.deepEqual(guardMeta.body, { version: 2 });
    const guardFull = await srv.request('GET', '/api/guard/site-plan', { token: guardia() });
    assert.equal(guardFull.body.plan.imageDataUrl, smallWebp);

    const removed = await srv.request('DELETE', '/api/admin/site-plan', { token: admin() });
    assert.equal(removed.status, 200, removed.text);
    const after = await srv.request('GET', '/api/admin/site-plan', { token: admin() });
    assert.equal(after.body.plan, null);

    const audit = await mem.db.collection('auditLog').get();
    const actions = audit.docs.map((doc) => doc.data().action);
    assert.ok(actions.includes('site_plan.update'));
    assert.ok(actions.includes('site_plan.delete'));
  });
});

describe('posición de la puerta en el plano', () => {
  const { normalizeDoorsConfig } = require('../lib/doorsConfig');
  const normalizeDoor = (door) => normalizeDoorsConfig({ doors: [door] }).doors[0];

  it('conserva mapPos válido y anula el inválido', () => {
    assert.deepEqual(normalizeDoor({ id: 'p1', mapPos: { x: 0.25, y: 1 } }).mapPos, { x: 0.25, y: 1 });
    assert.equal(normalizeDoor({ id: 'p1', mapPos: { x: 1.2, y: 0.5 } }).mapPos, null);
    assert.equal(normalizeDoor({ id: 'p1', mapPos: { x: '0.5', y: 0.5 } }).mapPos, null);
    assert.equal(normalizeDoor({ id: 'p1', mapPos: 'arriba' }).mapPos, null);
    assert.equal(normalizeDoor({ id: 'p1' }).mapPos, null);
  });
});
