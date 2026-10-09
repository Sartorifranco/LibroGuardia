'use strict';

/**
 * Comandos nube → hub sobre el Firestore con contadores reales (countingFirestore):
 * GET /api/edge/v1/commands?status=pending, contador `sites/{s}/status/commands`,
 * `pendingCommands` en GET /head y resultados con la forma que manda el hub.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startEdgeCloud } = require('./helpers/edgeCloudHarness');
const { defaultRoleDocs, signTestToken, TEST_JWT_SECRET } = require('./helpers/routeHarness');

const user = (role) => ({ username: role, role, active: true, passwordVersion: 1, permissions: [] });

describe('Edge: comandos pendientes y señal en el head', () => {
  let cloud;
  let edgeIngest;
  let hubToken;
  let ctlToken;
  const guardiaToken = signTestToken({ id: 'guardia', role: 'guardia', username: 'guardia' });

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    cloud = await startEdgeCloud({
      routers: ['routes/edge.js'],
      initial: {
        roles: defaultRoleDocs(),
        users: { guardia: user('guardia'), admin: user('admin') },
        devices: {
          'hub-1': { siteId: 'principal', kind: 'hub', name: 'Hub', status: 'active', doorIds: [] },
          'ctl-a': { siteId: 'principal', kind: 'controller', name: 'Pi', status: 'active', doorIds: ['p1'] }
        },
        'settings/doorsConfig': { doors: [{ id: 'p1', name: 'Puerta 1', controllerId: 'ctl-a' }] },
        'settings/accessControl': {}
      }
    });
    const devices = require('../lib/devices');
    edgeIngest = require('../lib/edgeIngest');
    edgeIngest.setSiteCompilerForTests({
      getHead: async () => ({ version: 7, chunks: {}, sig: 's', keyId: 'k' }),
      getChunks: async () => ({}),
      getSigningPublicKey: async () => ({ keyId: 'k', publicKey: 'pem' })
    });
    hubToken = devices.signDeviceToken({ deviceId: 'hub-1', siteId: 'principal', deviceKind: 'hub' });
    ctlToken = devices.signDeviceToken({ deviceId: 'ctl-a', siteId: 'principal', deviceKind: 'controller' });
  });

  after(async () => {
    edgeIngest.setSiteCompilerForTests(undefined);
    await cloud.stop();
  });

  const head = async () => {
    const res = await cloud.request('GET', '/api/edge/v1/head', { token: hubToken });
    assert.equal(res.status, 200, res.text);
    return res.body;
  };
  const counter = () => cloud.fs.peek('sites/principal/status/commands');

  it('head sin comandos: pendingCommands 0 con 1 sola lectura extra', async () => {
    cloud.fs.resetStats();
    const h = await head();
    assert.equal(h.pendingCommands, 0);
    assert.equal(cloud.fs.stats.reads, 1, cloud.fs.stats.log.join('\n'));
    assert.equal(cloud.fs.stats.writes, 0);
  });

  it('crear → pendiente en el head → el hub lo lista → resultado del hub → contador en 0', async () => {
    cloud.fs.resetStats();
    const created = await cloud.request('POST', '/api/guard/doors/p1/remote-open', { token: guardiaToken, body: { reason: 'proveedor' } });
    assert.equal(created.status, 202, created.text);
    const cmdWrites = cloud.fs.stats.log.filter((l) => l.startsWith('W ') && /commands/.test(l));
    assert.equal(cmdWrites.length, 2, cmdWrites.join('\n')); // comando + contador
    assert.equal(counter().pending, 1);
    assert.equal((await head()).pendingCommands, 1);

    assert.equal((await cloud.request('GET', '/api/edge/v1/commands?status=pending', { token: ctlToken })).status, 403);
    assert.equal((await cloud.request('GET', '/api/edge/v1/commands?status=done', { token: hubToken })).status, 400);

    cloud.fs.resetStats();
    const list = await cloud.request('GET', '/api/edge/v1/commands?status=pending', { token: hubToken });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.commands.length, 1);
    const cmd = list.body.commands[0];
    assert.equal(cmd.id, created.body.command.id);
    assert.equal(cmd.doorId, 'p1');
    assert.equal(cmd.controllerId, 'ctl-a');
    assert.equal(cmd.action, 'open');
    assert.equal(cloud.fs.stats.reads, 1);
    assert.equal(cloud.fs.stats.writes, 0);

    // Forma real del hub (scripts/edge/hub/commands.js report()).
    const res = await cloud.request('POST', `/api/edge/v1/commands/${cmd.id}/result`, {
      token: hubToken,
      body: { hubId: 'hub-1', status: 'done', result: { ok: true, controllerId: 'ctl-a', relayConfirmed: true, eventId: 'ctl-a:9' }, ts: Date.now() }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.command.status, 'done');
    assert.equal(res.body.command.result.relayConfirmed, true);
    assert.equal(res.body.command.result.controllerId, 'ctl-a');
    assert.equal(counter().pending, 0);
    const dup = await cloud.request('POST', `/api/edge/v1/commands/${cmd.id}/result`, { token: hubToken, body: { status: 'failed' } });
    assert.equal(dup.body.command.duplicate, true);
    assert.equal(counter().pending, 0);
    assert.equal((await head()).pendingCommands, 0);
  });

  it('vencido: el listado lo marca expired y descuenta; un resultado tardío no descuenta de nuevo', async () => {
    const created = await cloud.request('POST', '/api/guard/doors/p1/remote-open', {
      token: guardiaToken,
      body: { forceAirlock: false, reason: 'tarde' }
    });
    const id = created.body.command.id;
    const p = `sites/principal/commands/${id}`;
    cloud.fs.poke(p, { ...cloud.fs.peek(p), expiresAt: Date.now() - 1 });
    assert.equal((await head()).pendingCommands, 1);
    const list = await cloud.request('GET', '/api/edge/v1/commands?status=pending', { token: hubToken });
    assert.deepEqual(list.body.commands, []);
    assert.equal(list.body.expired, 1);
    assert.equal(cloud.fs.peek(p).status, 'expired');
    assert.equal(counter().pending, 0);

    const late = await cloud.request('POST', `/api/edge/v1/commands/${id}/result`, {
      token: hubToken, body: { status: 'done', result: { ok: true, relayConfirmed: true } }
    });
    assert.equal(late.status, 200);
    assert.equal(cloud.fs.peek(p).lateResult, true);
    assert.equal(counter().pending, 0);
    const again = await cloud.request('POST', `/api/edge/v1/commands/${id}/result`, { token: hubToken, body: { status: 'done' } });
    assert.equal(again.body.command.duplicate, true);
  });

  it('heartbeat del hub: estado por controlador en devices/{id} solo cuando cambia', async () => {
    cloud.fs.poke('devices/ctl-x', { siteId: 'otro', kind: 'controller', status: 'active' });
    const body = (v, online = true) => ({
      hubId: 'hub-1',
      siteId: 'principal',
      configVersionApplied: 9,
      controllers: {
        'ctl-a': { configVersionApplied: v, lastSeenAt: Date.now(), online, lastError: null },
        'ctl-x': { configVersionApplied: v, lastSeenAt: Date.now(), online: true },
        'hub-1': { configVersionApplied: v, online: true }
      },
      checks: { db: 'ok' },
      lanUrl: 'http://192.168.0.10:8080'
    });
    const hb = (b) => cloud.request('POST', '/api/edge/v1/heartbeat', { token: hubToken, body: b });

    const first = await hb(body(9));
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.controllersWritten, 1);
    assert.equal(first.body.controllersIgnored, 2, 'otro sitio y no-controlador se ignoran');
    const ctl = cloud.fs.peek('devices/ctl-a');
    assert.equal(ctl.configVersionApplied, 9);
    assert.equal(ctl.online, true);
    assert.equal(ctl.reportedBy, 'hub-1');
    assert.equal(cloud.fs.peek('devices/ctl-x').configVersionApplied, undefined);
    const hubDoc = cloud.fs.peek('devices/hub-1');
    assert.equal(hubDoc.configVersionApplied, 9, 'campos propios del hub se mantienen');
    assert.equal(hubDoc.lanUrl, 'http://192.168.0.10:8080');
    assert.equal(hubDoc.controllersReported['ctl-a'].configVersionApplied, 9);

    // Sin cambios: 1 lectura (doc del hub) + las de equipos inválidos que se re-validan; 0 escrituras al controlador.
    cloud.fs.resetStats();
    const same = await hb(body(9));
    assert.equal(same.body.controllersWritten, 0);
    assert.ok(!cloud.fs.stats.log.some((l) => l === 'W set devices/ctl-a'), cloud.fs.stats.log.join('\n'));

    // Cambia la versión aplicada y se cae: se escribe.
    cloud.fs.resetStats();
    const changed = await hb(body(10, false));
    assert.equal(changed.body.controllersWritten, 1);
    assert.equal(cloud.fs.peek('devices/ctl-a').configVersionApplied, 10);
    assert.equal(cloud.fs.peek('devices/ctl-a').online, false);
    const list = await cloud.request('GET', '/api/admin/devices', { token: signTestToken({ id: 'admin', role: 'admin', username: 'admin' }) });
    assert.equal(list.status, 200, list.text);
    {
      const a = list.body.devices.find((d) => d.id === 'ctl-a');
      assert.equal(a.online, false);
    }
  });

  it('el hub puede reportar expired/rejected; contador negativo se acota a 0; listado vacío re-sincroniza', async () => {
    const created = await cloud.request('POST', '/api/guard/doors/p1/remote-open', { token: guardiaToken, body: {} });
    const r = await cloud.request('POST', `/api/edge/v1/commands/${created.body.command.id}/result`, {
      token: hubToken, body: { status: 'rejected', result: { ok: false, code: 'ACTION_UNSUPPORTED' } }
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.command.result.code, 'ACTION_UNSUPPORTED');
    cloud.fs.poke('sites/principal/status/commands', { pending: -3 });
    assert.equal((await head()).pendingCommands, 0);
    cloud.fs.poke('sites/principal/status/commands', { pending: 4 });
    const list = await cloud.request('GET', '/api/edge/v1/commands?status=pending', { token: hubToken });
    assert.deepEqual(list.body.commands, []);
    assert.equal(counter().pending, 0);
  });
});
