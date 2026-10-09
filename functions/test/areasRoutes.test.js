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

describe('lugares y puesta en marcha', () => {
  let mem;
  let srv;
  const dirty = [];

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          admin: { username: 'admin', role: 'admin', active: true, passwordVersion: 1, permissions: [] },
          guardia: { username: 'g', role: 'guardia', active: true, passwordVersion: 1, permissions: [] },
          jefe: { username: 'jefe', role: 'supervisor', active: true, passwordVersion: 1, permissions: [] }
        }
      },
      stubs: {
        'lib/siteCompiler': {
          markDirty: (change) => {
            dirty.push(change);
            return Promise.resolve(true);
          }
        }
      }
    });
    srv = await startRouters(['routes/areas.js', 'routes/setupStatus.js']);
  });

  after(async () => { await srv.close(); });

  const token = (id, role) => signTestToken({ id, role });

  it('un guardia no administra lugares', async () => {
    const res = await srv.request('GET', '/api/admin/areas', { token: token('guardia', 'guardia') });
    assert.equal(res.status, 403);
  });

  it('crea, renombra y no deja borrar el exterior', async () => {
    const created = await srv.request('POST', '/api/admin/areas', {
      token: token('admin', 'admin'),
      body: { name: 'Oficinas' }
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.area.id, 'oficinas');
    assert.equal(created.body.area.name, 'Oficinas');
    assert.ok(dirty.some((item) => item.doors === true));

    const list = await srv.request('GET', '/api/admin/areas', { token: token('admin', 'admin') });
    assert.equal(list.status, 200);
    assert.equal(list.body.areas[0].id, 'exterior');
    assert.equal(list.body.areas[0].fixed, true);
    assert.ok(list.body.areas.some((area) => area.id === 'oficinas'));

    const renamed = await srv.request('PUT', '/api/admin/areas/oficinas', {
      token: token('admin', 'admin'),
      body: { name: 'Oficinas norte' }
    });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.area.name, 'Oficinas norte');

    const exterior = await srv.request('DELETE', '/api/admin/areas/exterior', { token: token('admin', 'admin') });
    assert.equal(exterior.status, 400);
    assert.match(exterior.body.message, /exterior/i);

    const removed = await srv.request('DELETE', '/api/admin/areas/oficinas', { token: token('admin', 'admin') });
    assert.equal(removed.status, 200, removed.text);
    const audit = await mem.db.collection('auditLog').get();
    assert.ok(audit.docs.some((doc) => doc.data().action === 'area.create'));
  });

  it('no borra un lugar que usa una puerta', async () => {
    await srv.request('POST', '/api/admin/areas', {
      token: token('admin', 'admin'),
      body: { name: 'Tesorería' }
    });
    mem.setDoc('settings', 'doorsConfig', {
      doors: [{
        id: 'p1',
        name: 'Bóveda',
        active: true,
        sides: { in: { zoneFrom: 'exterior', zoneTo: 'tesoreria' } }
      }]
    });
    const res = await srv.request('DELETE', '/api/admin/areas/tesoreria', { token: token('admin', 'admin') });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Bóveda/);
  });

  it('el jefe puede leer la puesta en marcha y el guardia no', async () => {
    const ok = await srv.request('GET', '/api/admin/setup-status', { token: token('jefe', 'supervisor') });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.steps.length, 9);
    const denied = await srv.request('GET', '/api/admin/setup-status', { token: token('guardia', 'guardia') });
    assert.equal(denied.status, 403);
  });
});
