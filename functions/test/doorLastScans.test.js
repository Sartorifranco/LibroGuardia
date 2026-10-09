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

describe('últimos escaneos de una puerta', () => {
  let mem;
  let srv;
  let mergeScans;
  const adminToken = () => signTestToken({ id: 'admin', role: 'admin' });
  const guardiaToken = () => signTestToken({ id: 'guardia', role: 'guardia' });

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          admin: { username: 'admin', role: 'admin', active: true, passwordVersion: 1, permissions: [] },
          guardia: { username: 'g', role: 'guardia', active: true, passwordVersion: 1, permissions: [] }
        }
      }
    });
    ({ mergeScans } = require('../lib/doorLastScans'));
    srv = await startRouters(['routes/peopleDoors.js']);
  });

  after(async () => { await srv.close(); });

  it('une y recorta por tiempo, sin mezclar puertas', () => {
    const page = mergeScans([
      { id: 'a', at: 1000, name: 'Ana', side: 'in', result: 'permitido' },
      { id: 'a', at: 1500, name: 'Ana', side: 'in', result: 'permitido' },
      { id: 'b', at: 3000, name: 'Beto', side: 'out', result: 'denegado' },
      { id: 'c', at: 2000, name: 'Ciro', side: 'in', result: 'permitido' }
    ], { limit: 2 });
    assert.equal(page.scans.length, 2);
    assert.equal(page.scans[0].id, 'b');
    assert.equal(page.scans[0].movement, 'salida');
    assert.equal(page.scans[0].result, 'denegado');
    assert.equal(page.scans[1].id, 'c');
    assert.equal(page.nextCursor, '2000');
    const older = mergeScans([
      { id: 'a', at: 1000, name: 'Ana', side: 'in' },
      { id: 'c', at: 2000, name: 'Ciro', side: 'in' }
    ], { limit: 5, before: 2000 });
    assert.deepEqual(older.scans.map((scan) => scan.id), ['a']);
  });

  it('un guardia no lee escaneos', async () => {
    const res = await srv.request('GET', '/api/admin/doors/p1/last-scans', { token: guardiaToken() });
    assert.equal(res.status, 403);
  });

  it('devuelve el journal y el libro, solo de esa puerta', async () => {
    mem.setDoc('entries', 'e-p1', {
      doorId: 'p1',
      name: 'Ana',
      movementType: 'ingreso',
      timestamp: 2000,
      accessAuthorized: true,
      edge: { eventId: 'ev-grant' }
    });
    mem.setDoc('entries', 'e-otra', {
      doorId: 'otra',
      name: 'Beto',
      movementType: 'ingreso',
      timestamp: 9000,
      accessAuthorized: true
    });
    mem.setDoc('sites/principal/journal', 'j1', {
      lastTs: 3000,
      events: [
        { id: 'ev-deny', ts: 3000, type: 'access', doorId: 'p1', side: 'in', decision: 'deny', payload: { name: 'Ana' } },
        { id: 'ev-otra', ts: 3000, type: 'access', doorId: 'otra', side: 'in', decision: 'grant', payload: { name: 'Beto' } },
        { id: 'ev-alarm', ts: 3100, type: 'alarm', doorId: 'p1', reason: 'held_open' }
      ]
    });

    const res = await srv.request('GET', '/api/admin/doors/p1/last-scans?limit=5', { token: adminToken() });
    assert.equal(res.status, 200, res.text);
    const ids = res.body.scans.map((scan) => scan.id);
    assert.deepEqual(ids, ['ev-deny', 'ev-grant']);
    assert.equal(res.body.scans[0].result, 'denegado');
    assert.match(res.body.scans[0].summary, /Ana/);
    assert.equal(res.body.scans.some((scan) => scan.name === 'Beto'), false);

    const one = await srv.request('GET', '/api/admin/doors/p1/last-scans?limit=1', { token: adminToken() });
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.scans.length, 1);
    assert.equal(one.body.scans[0].id, 'ev-deny');
  });
});
