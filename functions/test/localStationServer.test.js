const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const bridgePath = path.join(__dirname, '..', '..', 'scripts', 'door-reader-bridge.js');
const {
  normalizeStationConfig,
  createLocalStationServer,
  buildStationLocalHandlers,
  extractStationSecret
} = require(bridgePath);

const request = (port, method, urlPath, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {}),
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_e) { data = { raw }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const reservePort = () => new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

describe('door-reader-bridge localServer config', () => {
  const baseEnv = { API_BASE_URL: '', DOOR_READER_CONFIG: '' };

  it('sin puerto local: localServerPort=0 (retrocompat)', () => {
    const station = normalizeStationConfig({
      apiBaseUrl: 'https://bacarguard.web.app/api',
      username: 'k',
      password: 'p',
      doorId: 'puerta-p1'
    }, baseEnv, 'C:\\cfg\\x.json');
    assert.equal(station.localServerPort, 0);
    assert.equal(station.localServerSecret, '');
  });

  it('puerto sin secreto → error', () => {
    assert.throws(
      () => normalizeStationConfig({
        apiBaseUrl: 'https://bacarguard.web.app/api',
        username: 'k',
        password: 'p',
        doorId: 'p1',
        localServerPort: 8787
      }, baseEnv, 'x.json'),
      /localServerSecret/
    );
  });

  it('puerto + secreto se normalizan', () => {
    const station = normalizeStationConfig({
      apiBaseUrl: 'https://bacarguard.web.app/api',
      username: 'k',
      password: 'p',
      doorId: 'p1',
      localServerPort: 8787,
      localServerSecret: 'station-secret',
      localServerHost: '127.0.0.1'
    }, baseEnv, 'x.json');
    assert.equal(station.localServerPort, 8787);
    assert.equal(station.localServerSecret, 'station-secret');
    assert.equal(station.localServerHost, '127.0.0.1');
  });
});

describe('extractStationSecret', () => {
  it('lee Bearer y headers alternativos', () => {
    assert.equal(
      extractStationSecret({ headers: { authorization: 'Bearer abc' } }),
      'abc'
    );
    assert.equal(
      extractStationSecret({ headers: { 'x-station-secret': 'xyz' } }),
      'xyz'
    );
    assert.equal(
      extractStationSecret({ headers: { 'x-bridge-secret': 'bridge' } }),
      'bridge'
    );
  });
});

describe('createLocalStationServer HTTP', () => {
  let live = null;
  let openCalls = [];

  after(async () => {
    if (live) {
      await live.close();
      live = null;
    }
  });

  it('401 sin secreto / secreto incorrecto; 200 status; open 200/404', async () => {
    openCalls = [];
    const runtimes = [
      {
        cfg: { doorId: 'puerta-p1', readerId: 'R1' },
        getStatus: () => ({
          doorId: 'puerta-p1',
          readerId: 'R1',
          connected: true,
          lastScanAt: '2026-07-23T12:00:00.000Z',
          allowlistFresh: true
        }),
        openLocal: async () => {
          openCalls.push('puerta-p1');
          return { via: 'tcp-local', host: '192.168.0.38', channel: 1 };
        }
      }
    ];
    const handlers = buildStationLocalHandlers(runtimes);
    const port = await reservePort();

    live = await createLocalStationServer({
      host: '127.0.0.1',
      port,
      secret: 'test-secret',
      getStatus: handlers.getStatus,
      openDoor: handlers.openDoor
    });

    const noAuth = await request(live.port, 'GET', '/status');
    assert.equal(noAuth.status, 401);

    const badAuth = await request(live.port, 'GET', '/status', {
      headers: { Authorization: 'Bearer wrong' }
    });
    assert.equal(badAuth.status, 401);

    const okStatus = await request(live.port, 'GET', '/status', {
      headers: { Authorization: 'Bearer test-secret' }
    });
    assert.equal(okStatus.status, 200);
    assert.equal(okStatus.data.ok, true);
    assert.equal(okStatus.data.readers.length, 1);
    assert.equal(okStatus.data.readers[0].doorId, 'puerta-p1');
    assert.equal(okStatus.data.readers[0].connected, true);
    assert.equal(okStatus.data.readers[0].allowlistFresh, true);

    const openOk = await request(live.port, 'POST', '/open/puerta-p1', {
      headers: { Authorization: 'Bearer test-secret' }
    });
    assert.equal(openOk.status, 200);
    assert.equal(openOk.data.ok, true);
    assert.deepEqual(openCalls, ['puerta-p1']);

    const openMissing = await request(live.port, 'POST', '/open/puerta-inexistente', {
      headers: { 'X-Station-Secret': 'test-secret' }
    });
    assert.equal(openMissing.status, 404);
    assert.match(openMissing.data.message, /no maneja/i);
  });
});
