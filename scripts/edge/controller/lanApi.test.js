'use strict';

const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const lanSign = require('../lib/lanSign');
const { SKIP, createTestController } = require('./_fixture');
const { createLanServer } = require('./lanApi');
const { HubClient, EdgeClock } = require('./hubClient');
const { normalizeConfig, ConfigError } = require('./config');
const mssEdge = require('../mss-edge');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

describe('API LAN del controlador (firmada)', { skip: SKIP }, () => {
  let t;
  let server;
  let base;
  before(async () => {
    t = await createTestController();
    server = createLanServer({ controller: t.controller, config: t.config });
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  after(async () => {
    server.close();
    await t.cleanup();
  });

  const call = (method, p, body, { key = t.hubKeys.privateKeyPem, keyId = 'hub-test' } = {}) => lanSign.signedFetch(`${base}${p}`, {
    method, body, privateKey: key, keyId
  });

  it('GET /edge/status firmado por el hub → 200 con puertas y hora', async () => {
    const r = await call('GET', '/edge/status');
    assert.equal(r.status, 200);
    assert.equal(r.data.deviceId, 'ctl-test');
    assert.equal(r.data.configVersion, 1);
    assert.deepEqual(r.data.doors.map((d) => d.id), ['p1', 'p2', 'p3']);
    assert.equal(r.data.doors[0].state, 'SEGURA');
    assert.ok(Number.isFinite(r.serverTimeMs));
  });

  it('sin firma, con otra clave o repetida → 401', async () => {
    const plain = await fetch(`${base}/edge/status`);
    assert.equal(plain.status, 401);
    const other = lanSign.generateKeyPair();
    assert.equal((await call('GET', '/edge/status', undefined, { key: other.privateKeyPem })).status, 401);
    assert.equal((await call('GET', '/edge/status', undefined, { keyId: 'intruso' })).data.code, 'SIG_UNKNOWN_KEY');
    const headers = lanSign.signRequest({ privateKey: t.hubKeys.privateKeyPem, keyId: 'hub-test', method: 'GET', path: '/edge/status' });
    assert.equal((await fetch(`${base}/edge/status`, { headers })).status, 200);
    const replay = await fetch(`${base}/edge/status`, { headers });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).code, 'SIG_REPLAY');
  });

  it('POST /edge/doors/:id/open → pulso real y evento; puerta ajena → 404', async () => {
    const r = await call('POST', '/edge/doors/p1/open', { requestedBy: { id: 'guardia1', permissions: [] }, reason: 'proveedor' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.relayConfirmed, true);
    assert.equal(r.data.reason, 'apertura_manual');
    const ev = t.edge.journal.get(r.data.eventId);
    assert.equal(ev.type, 'manual_open');
    assert.equal(ev.payload.requestedBy, 'guardia1');
    const again = await call('POST', '/edge/doors/p1/open', { requestedBy: 'guardia1' });
    assert.equal(again.status, 429);
    assert.equal((await call('POST', '/edge/doors/otra/open', { requestedBy: 'x' })).status, 404);
  });

  it('POST /edge/sim/input mueve entradas simuladas', async () => {
    const r = await call('POST', '/edge/sim/input', { doorId: 'p3', input: 'dps', value: 'open' });
    assert.equal(r.status, 200);
    assert.equal(r.data.value, 'open');
    assert.equal((await call('POST', '/edge/sim/input', { doorId: 'p3', input: 'dps', value: 'x' })).status, 400);
    t.controller.simInput('p3', 'dps', 'closed');
  });

  it('POST /edge/config/notify → 202 y sincroniza', async () => {
    const r = await call('POST', '/edge/config/notify', { version: 1 });
    assert.equal(r.status, 202);
    assert.equal(r.data.configVersion, 1);
  });

  it('simulación deshabilitada → 403', async () => {
    t.config.simulation.enabled = false;
    try {
      assert.equal((await call('POST', '/edge/sim/input', { doorId: 'p1', input: 'dps', value: 'open' })).status, 403);
    } finally {
      t.config.simulation.enabled = true;
    }
  });
});

describe('HubClient: requests firmadas y desfase de reloj', () => {
  it('el hub verifica la firma del controlador y su hora corrige el reloj', async () => {
    const ctlKey = lanSign.generateKeyPair();
    let skew = 0;
    const seen = [];
    const hubServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const v = lanSign.verifyRequest({
          method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks),
          resolveKey: (id) => (id === 'ctl-x' ? ctlKey.publicKeyB64 : null)
        });
        seen.push({ url: req.url, ok: v.ok });
        res.writeHead(v.ok ? 200 : 401, { 'content-type': 'application/json', 'x-mss-time': String(Date.now() + skew) });
        res.end(JSON.stringify(v.ok ? { head: { version: 1 }, chunks: {}, ackSeq: 0 } : { code: v.code }));
      });
    });
    const port = await listen(hubServer);
    try {
      const clock = new EdgeClock({ trusted: 'auto' });
      const hub = new HubClient({ url: `http://127.0.0.1:${port}`, deviceId: 'ctl-x', privateKey: ctlKey.privateKeyPem, clock });
      assert.equal(clock.trusted(), false, 'sin muestra todavía');
      await hub.getChunks(['doors', 'ch-01']);
      assert.equal(seen[0].url, '/edge/config/chunks?names=doors%2Cch-01');
      assert.equal(seen[0].ok, true);
      assert.equal(clock.trusted(), true);
      assert.ok(Math.abs(clock.offsetMs) < 1000);
      skew = 10 * 60 * 1000; // hub 10 min adelantado
      await hub.pushEvents({ deviceId: 'ctl-x', events: [] });
      assert.ok(clock.offsetMs > 9 * 60 * 1000);
      assert.equal(clock.trusted(), false, 'deriva > 2 min → reloj no confiable');
      assert.equal(clock.quality(), 'drift');
      const bad = new HubClient({ url: `http://127.0.0.1:${port}`, deviceId: 'ctl-otro', privateKey: ctlKey.privateKeyPem });
      await assert.rejects(bad.getChunks(), (err) => err.status === 401);
    } finally {
      hubServer.close();
    }
  });

  it('hub caído → HubError HUB_UNREACHABLE', async () => {
    const hub = new HubClient({ url: 'http://127.0.0.1:1', deviceId: 'x', privateKey: lanSign.generateKeyPair().privateKeyPem, timeoutMs: 1000 });
    await assert.rejects(hub.getChunks(), (err) => err.code === 'HUB_UNREACHABLE');
  });
});

describe('config local y CLI', () => {
  it('config.ejemplo.json es válida (con claves de prueba)', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.ejemplo.json'), 'utf8'));
    const kp = lanSign.generateKeyPair();
    raw.hub.publicKey = kp.publicKeyB64;
    raw.cloud.headPublicKey = kp.publicKeyB64;
    const cfg = normalizeConfig(raw, __dirname);
    assert.equal(cfg.doors[0].id, 'puerta-p1');
    assert.equal(cfg.doors[0].output.host, '192.168.0.38');
    assert.equal(cfg.doors[0].readers[0].port, 'COM3');
    assert.equal(cfg.interlock.mode, 'off');
    assert.equal(cfg.lan.bind, '0.0.0.0');
    assert.throws(() => normalizeConfig({ ...raw, cloud: {} }, __dirname), ConfigError);
    assert.throws(() => normalizeConfig({ ...raw, doors: [] }, __dirname), /al menos una puerta/);
  });

  it('mss-edge: argumentos y roles', async () => {
    assert.deepEqual(mssEdge.parseArgs(['--role=controller', '--config', 'a.json', '--print-key']), {
      role: 'controller', configPath: 'a.json', rest: ['--print-key']
    });
    await assert.rejects(mssEdge.run(['--role=otro']), (err) => err.code === 'BAD_ROLE');
    if (!fs.existsSync(path.join(__dirname, '..', 'hub'))) {
      assert.throws(() => mssEdge.loadRole('hub'), (err) => err.code === 'HUB_MISSING');
    }
    assert.equal(typeof mssEdge.loadRole('controller').main, 'function');
  });
});
