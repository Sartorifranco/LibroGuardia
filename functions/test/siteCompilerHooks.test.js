'use strict';

/**
 * Ganchos markDirty en las rutas que mutan datos de acceso: una escritura en
 * sites/principal/compiled/_dirty, sin romper la respuesta de la ruta.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupHarness, startRouters, defaultRoleDocs, signTestToken, TEST_JWT_SECRET } = require('./helpers/routeHarness');

const waitDirty = async (mem, predicate) => {
  for (let i = 0; i < 50; i += 1) {
    const doc = mem.getDoc('sites/principal/compiled', '_dirty');
    if (doc && predicate(doc)) return doc;
    await new Promise((r) => setTimeout(r, 10));
  }
  return mem.getDoc('sites/principal/compiled', '_dirty') || null;
};

describe('siteCompiler: ganchos de rutas', () => {
  let mem;
  let srv;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: { admin: { username: 'admin', role: 'admin', active: true, passwordVersion: 1, permissions: [] } },
        people: {
          p1: { name: 'Juan', dniNormalized: '30111222', allowedDoorIds: ['d1'], active: true },
          p2: { name: 'Ana', dniNormalized: '30111333', allowedDoorIds: ['d1'], active: true }
        }
      }
    });
    srv = await startRouters(['routes/peopleDoors.js']);
  });

  after(async () => { await srv.close(); });

  it('cambiar puertas por DNI marca la persona como sucia', async () => {
    const res = await srv.request('PUT', '/api/admin/people/by-dni/allowed-doors', {
      token: signTestToken({ id: 'admin', role: 'admin' }),
      body: { idNumber: '30111222', allowedDoorIds: ['d1', 'd2'] }
    });
    assert.equal(res.status, 200, res.text);
    const dirty = await waitDirty(mem, (d) => Array.isArray(d.people) && d.people.includes('p1'));
    assert.ok(dirty && dirty.people.includes('p1'), JSON.stringify(dirty));
  });

  it('quitar una puerta a una persona marca la persona como sucia', async () => {
    const res = await srv.request('DELETE', '/api/admin/doors/d1/people/p2', {
      token: signTestToken({ id: 'admin', role: 'admin' })
    });
    assert.equal(res.status, 200, res.text);
    const dirty = await waitDirty(mem, (d) => Array.isArray(d.people) && d.people.includes('p2'));
    assert.ok(dirty && dirty.people.includes('p2'), JSON.stringify(dirty));
  });
});
