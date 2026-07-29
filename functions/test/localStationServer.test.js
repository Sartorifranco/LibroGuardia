const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const bridgePath = path.join(__dirname, '..', '..', 'scripts', 'door-reader-bridge.js');
const {
  normalizeStationConfig,
  createLocalStationServer,
  buildStationLocalHandlers,
  extractStationSecret,
  isAllowedCorsOrigin,
  buildCorsHeaders,
  BRIDGE_VERSION,
  LOCAL_STATION_API_VERSION
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
        resolve({ status: res.statusCode, headers: res.headers, data });
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
      apiBaseUrl: 'https://mss-guard.web.app/api',
      username: 'k',
      password: 'p',
      doorId: 'puerta-p1'
    }, baseEnv, 'C:\\cfg\\x.json');
    assert.equal(station.localServerPort, 0);
    assert.equal(station.localServerSecret, '');
  });

  it('puerto sin secreto â†’ error', () => {
    assert.throws(
      () => normalizeStationConfig({
        apiBaseUrl: 'https://mss-guard.web.app/api',
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
      apiBaseUrl: 'https://mss-guard.web.app/api',
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
        openLocal: async (relayOverride = null) => {
          openCalls.push({ doorId: 'puerta-p1', relay: relayOverride });
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
    assert.equal(okStatus.data.bridgeVersion, BRIDGE_VERSION);
    assert.equal(okStatus.data.localStationApiVersion, LOCAL_STATION_API_VERSION);
    assert.equal(okStatus.data.readers.length, 1);
    assert.equal(okStatus.data.readers[0].doorId, 'puerta-p1');
    assert.equal(okStatus.data.readers[0].connected, true);
    assert.equal(okStatus.data.readers[0].allowlistFresh, true);

    const openOk = await request(live.port, 'POST', '/open/puerta-p1', {
      headers: { Authorization: 'Bearer test-secret' }
    });
    assert.equal(openOk.status, 200);
    assert.equal(openOk.data.ok, true);
    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0].doorId, 'puerta-p1');
    assert.equal(openCalls[0].relay, null);

    const openWithRelay = await request(live.port, 'POST', '/open/puerta-p1', {
      headers: { Authorization: 'Bearer test-secret' },
      body: {
        localRelay: {
          host: '192.168.0.38',
          port: 6722,
          channel: 2,
          pulseSeconds: 5
        }
      }
    });
    assert.equal(openWithRelay.status, 200);
    assert.equal(openCalls.length, 2);
    assert.equal(openCalls[1].relay.host, '192.168.0.38');
    assert.equal(openCalls[1].relay.channel, 2);
    assert.equal(openCalls[1].relay.pulseSeconds, 5);

    const panel = await request(live.port, 'GET', '/');
    assert.equal(panel.status, 200);
    assert.match(String(panel.data.raw || ''), /Prueba de apertura local/);

    const openMissing = await request(live.port, 'POST', '/open/puerta-inexistente', {
      headers: { 'X-Station-Secret': 'test-secret' }
    });
    assert.equal(openMissing.status, 404);
    assert.match(openMissing.data.message, /no maneja/i);
  });

  it('CORS + PNA: OPTIONS preflight y GET/POST con Origin de mss-guard', async () => {
    openCalls = [];
    const handlers = buildStationLocalHandlers([
      {
        cfg: { doorId: 'puerta-p1', readerId: 'R1' },
        getStatus: () => ({ doorId: 'puerta-p1', connected: true }),
        openLocal: async () => {
          openCalls.push('cors-open');
          return { via: 'tcp-local' };
        }
      }
    ]);
    const port = await reservePort();
    if (live) await live.close();
    live = await createLocalStationServer({
      host: '127.0.0.1',
      port,
      secret: 'test-secret',
      getStatus: handlers.getStatus,
      openDoor: handlers.openDoor
    });

    const origin = 'https://mss-guard.web.app';
    const preflight = await request(live.port, 'OPTIONS', '/status', {
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
        'Access-Control-Request-Private-Network': 'true'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], origin);
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
    assert.match(
      String(preflight.headers['access-control-allow-methods'] || ''),
      /GET/
    );
    assert.match(
      String(preflight.headers['access-control-allow-headers'] || ''),
      /authorization/i
    );

    const statusCors = await request(live.port, 'GET', '/status', {
      headers: {
        Origin: origin,
        Authorization: 'Bearer test-secret'
      }
    });
    assert.equal(statusCors.status, 200);
    assert.equal(statusCors.headers['access-control-allow-origin'], origin);
    assert.equal(statusCors.headers['access-control-allow-private-network'], 'true');

    const openCors = await request(live.port, 'POST', '/open/puerta-p1', {
      headers: {
        Origin: origin,
        Authorization: 'Bearer test-secret',
        'Access-Control-Request-Private-Network': 'true'
      }
    });
    assert.equal(openCors.status, 200);
    assert.equal(openCors.headers['access-control-allow-origin'], origin);
    assert.deepEqual(openCalls, ['cors-open']);

    // Origen no autorizado: sin Allow-Origin (el browser bloquearÃ­a leer la respuesta).
    const evil = await request(live.port, 'OPTIONS', '/open/puerta-p1', {
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization'
      }
    });
    assert.equal(evil.status, 204);
    assert.equal(evil.headers['access-control-allow-origin'], undefined);

    // Sin secreto sigue 401 aunque el Origin sea vÃ¡lido (CORS â‰  auth).
    const noSecret = await request(live.port, 'POST', '/open/puerta-p1', {
      headers: { Origin: origin }
    });
    assert.equal(noSecret.status, 401);
    assert.equal(noSecret.headers['access-control-allow-origin'], origin);
  });
});

describe('CORS helpers', () => {
  it('isAllowedCorsOrigin acepta hosting y localhost', () => {
    assert.equal(isAllowedCorsOrigin('https://mss-guard.web.app'), true);
    assert.equal(isAllowedCorsOrigin('https://mss-guard.firebaseapp.com'), true);
    assert.equal(isAllowedCorsOrigin('http://localhost:3000'), true);
    assert.equal(isAllowedCorsOrigin('https://evil.example'), false);
  });

  it('buildCorsHeaders no usa wildcard', () => {
    const headers = buildCorsHeaders({
      headers: { origin: 'https://mss-guard.web.app' }
    });
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://mss-guard.web.app');
    assert.notEqual(headers['Access-Control-Allow-Origin'], '*');
  });
});