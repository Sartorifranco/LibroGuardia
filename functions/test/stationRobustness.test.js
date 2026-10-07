const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const bridgePath = path.join(__dirname, '..', '..', 'scripts', 'programa-estacion.js');
const {
  applyOfflineQueueCap,
  splitOfflineBatches,
  OFFLINE_QUEUE_BATCH_SIZE,
  DEFAULT_OFFLINE_QUEUE_MAX,
  maskIdNumber,
  summarizeScanForLog,
  redactForLog,
  rotateLogFile,
  secretsMatch,
  openRelayRequestFromBody,
  restrictOpenRelayRequest,
  sanitizeLocalRelay,
  startBackgroundLogin,
  startReaderRuntime,
  writeJsonFile,
  createLocalStationServer,
  LOGIN_RETRY_MIN_MS,
  LOGIN_RETRY_MAX_MS,
  nextLoginBackoffMs
} = require(bridgePath);
const { writeJsonFileAtomic } = require('../../scripts/lib/atomicJson');
const { nextStationHealthState, STATION_HEALTH_DEFAULTS } = require('../../scripts/lib/watchdogSettings');

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
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_err) { data = { raw }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const reservePort = () => new Promise((resolve) => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

const readerCfg = (overrides = {}) => ({
  apiBaseUrl: 'http://127.0.0.1:9',
  username: 'kiosk',
  password: 'no-se-loguea',
  doorId: 'puerta-a',
  readerId: 'lector-a',
  serialPort: 'COM9',
  baudRate: 9600,
  idleMs: 120,
  inputMode: 'serial',
  plugin: 'serial_dni',
  logFile: '',
  reconnectMinMs: 2000,
  reconnectMaxMs: 60000,
  offlineCache: false,
  localFirstMode: false,
  offlineCacheRefreshMs: 60000,
  offlineCacheMaxAgeHours: 24,
  offlineAllowlistFile: '',
  offlineQueueFile: '',
  onlineScanTimeoutMs: 1000,
  allowlistTimeoutMs: 1000,
  localRelay: null,
  offlineQueueMax: 5000,
  ...overrides
});

describe('cola offline', () => {
  const event = (id, authorized) => ({
    offlineLocalId: id,
    authorized,
    dniNormalized: '30123456'
  });

  it('parte el envío en lotes de 200 como máximo', () => {
    const queue = Array.from({ length: 450 }, (_, i) => event(String(i), true));
    const batches = splitOfflineBatches(queue);
    assert.equal(OFFLINE_QUEUE_BATCH_SIZE, 200);
    assert.deepEqual(batches.map((batch) => batch.length), [200, 200, 50]);
    assert.ok(splitOfflineBatches(queue, 500).every((batch) => batch.length <= 200));
  });

  it('al pasar el tope descarta primero los denegados más viejos', () => {
    const queue = [
      event('d-viejo', false),
      event('ok-1', true),
      event('d-medio', false),
      event('ok-2', true),
      event('d-nuevo', false)
    ];
    const capped = applyOfflineQueueCap(queue, 3);
    assert.equal(capped.droppedDenied, 2);
    assert.equal(capped.authorizedOverflow, false);
    assert.deepEqual(capped.queue.map((item) => item.offlineLocalId), ['ok-1', 'ok-2', 'd-nuevo']);
  });

  it('no descarta autorizados: si solo quedan esos, los conserva y avisa', () => {
    const queue = [event('a', true), event('b', true), event('c', true)];
    const capped = applyOfflineQueueCap(queue, 2);
    assert.equal(capped.droppedDenied, 0);
    assert.equal(capped.authorizedOverflow, true);
    assert.equal(capped.queue.length, 3);
    assert.equal(DEFAULT_OFFLINE_QUEUE_MAX, 5000);
  });
});

describe('logs sin datos sensibles', () => {
  it('enmascara el DNI y no deja el frame crudo en el resumen', () => {
    const raw = '30123456@PEREZ@JUAN';
    assert.equal(maskIdNumber('30123456'), '*****456');
    const summary = summarizeScanForLog(raw, { reason: 'CR' });
    const dumped = JSON.stringify(summary);
    assert.equal(summary.dni, '*****456');
    assert.equal(dumped.includes('30123456'), false);
    assert.equal(dumped.includes('PEREZ'), false);
    assert.equal(summary.reason, 'CR');
  });

  it('omite token, secreto y clave del relé', () => {
    const redacted = redactForLog({
      host: '192.168.0.38',
      port: 6722,
      channel: 1,
      httpUrl: 'http://192.168.0.40/pulse',
      httpAuthToken: 'token-real',
      secret: 's3cret',
      password: 'clave'
    });
    assert.deepEqual(redacted, {
      host: '192.168.0.38',
      port: 6722,
      channel: 1,
      httpUrl: 'http://192.168.0.40/pulse'
    });
  });

  it('rota el log al pasar el tamaño y conserva los anteriores', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-log-'));
    const file = path.join(dir, 'estacion.log');
    fs.writeFileSync(file, 'a'.repeat(80));
    assert.equal(rotateLogFile(file, { maxBytes: 40, keep: 5 }), true);
    assert.equal(fs.existsSync(`${file}.1`), true);
    fs.writeFileSync(file, 'b'.repeat(80));
    rotateLogFile(file, { maxBytes: 40, keep: 5 });
    assert.equal(fs.readFileSync(`${file}.2`, 'utf8')[0], 'a');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8')[0], 'b');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('secreto y apertura local', () => {
  it('compara el secreto en buffers de igual longitud', () => {
    assert.equal(secretsMatch('estacion-ok', 'estacion-ok'), true);
    assert.equal(secretsMatch('estacion-ok', 'estacion-no'), false);
    assert.equal(secretsMatch('corto', 'estacion-ok'), false);
    assert.equal(secretsMatch('', 'estacion-ok'), false);
    assert.equal(secretsMatch('estacion-ok', ''), false);
  });

  it('el body no puede cambiar host, puerto ni URL', () => {
    const configured = sanitizeLocalRelay({
      driver: 'sr201',
      host: '192.168.0.38',
      port: 6722,
      channel: 1
    });
    const fromBody = openRelayRequestFromBody({
      localRelay: {
        host: '10.1.1.1',
        port: 9,
        httpUrl: 'http://evil.example/open',
        httpAuthToken: 'robado',
        channel: 2
      }
    });
    assert.deepEqual(fromBody, { channel: 2 });
    const relay = restrictOpenRelayRequest(configured, {
      host: '10.1.1.1',
      port: 9,
      httpUrl: 'http://evil.example/open',
      channel: 2
    });
    assert.equal(relay.host, '192.168.0.38');
    assert.equal(relay.port, 6722);
    assert.equal(relay.httpUrl, '');
    assert.equal(relay.channel, 1);
    const sameChannel = restrictOpenRelayRequest(configured, { channel: 1, host: '10.1.1.1' });
    assert.equal(sameChannel.host, '192.168.0.38');
    assert.equal(sameChannel.channel, 1);
  });

  it('POST /open no reenvía el host del body', async () => {
    const openCalls = [];
    const port = await reservePort();
    const live = await createLocalStationServer({
      host: '127.0.0.1',
      port,
      secret: 'test-secret',
      getStatus: () => ({ readers: [] }),
      openDoor: async (_doorId, relay) => {
        openCalls.push(relay);
        return { notFound: false };
      }
    });
    try {
      const denied = await request(live.port, 'POST', '/open/puerta-p1', {
        body: { localRelay: { host: '10.9.9.9', port: 1, httpUrl: 'http://evil' } }
      });
      assert.equal(denied.status, 401);

      const opened = await request(live.port, 'POST', '/open/puerta-p1', {
        headers: { Authorization: 'Bearer test-secret' },
        body: {
          host: '10.9.9.9',
          localRelay: {
            host: '10.9.9.9',
            port: 9999,
            httpUrl: 'http://evil.example/open',
            httpAuthToken: 'no',
            channel: 2
          }
        }
      });
      assert.equal(opened.status, 200);
      assert.equal(openCalls.length, 1);
      assert.deepEqual(openCalls[0], { channel: 2 });
    } finally {
      await live.close();
    }
  });
});

describe('escritura atómica', () => {
  const dirs = [];
  after(() => {
    dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('reemplaza el JSON sin dejar el temporal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-json-'));
    dirs.push(dir);
    const file = path.join(dir, 'configuracion-estacion.json');
    writeJsonFileAtomic(file, { version: 1 });
    writeJsonFile(file, { version: 2, readers: [{ doorId: 'p1' }] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      version: 2,
      readers: [{ doorId: 'p1' }]
    });
    const tmp = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(tmp, []);
  });
});

describe('login de un lector no bloquea al otro', () => {
  it('un login que no vuelve deja arrancar al otro lector', async () => {
    const sleep = () => new Promise(() => {});
    const hung = startReaderRuntime(readerCfg({ readerId: 'malo', doorId: 'd-malo' }), {
      skipHardware: true,
      sleep,
      requestJson: () => new Promise(() => {})
    });
    const ok = startReaderRuntime(readerCfg({ readerId: 'bueno', doorId: 'd-bueno' }), {
      skipHardware: true,
      sleep,
      requestJson: async () => ({ status: 200, data: { token: 'tok-bueno' } })
    });
    const timeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('el arranque quedó esperando un login')), 800);
    });
    const [badRuntime, goodRuntime] = await Promise.race([
      Promise.all([hung, ok]),
      timeout
    ]);
    assert.equal(badRuntime.cfg.readerId, 'malo');
    assert.equal(goodRuntime.cfg.readerId, 'bueno');
    for (let i = 0; i < 20 && !goodRuntime.getStatus().loginOk; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(goodRuntime.getStatus().loginOk, true);
    badRuntime.stop();
    goodRuntime.stop();
  });

  it('401/403 queda en /status con el texto para el técnico', async () => {
    const runtime = await startReaderRuntime(readerCfg({ readerId: 'molinete' }), {
      skipHardware: true,
      sleep: () => new Promise(() => {}),
      requestJson: async () => ({ status: 401, data: { message: 'Unauthorized' } })
    });
    let status = runtime.getStatus();
    for (let i = 0; i < 20 && !status.loginError; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      status = runtime.getStatus();
    }
    assert.equal(status.loginOk, false);
    assert.equal(status.loginCredentialError, true);
    assert.match(status.loginError, /Usuario o clave del lector molinete incorrectos/);
    assert.match(status.loginError, /01-instalar-estacion\.cmd/);
    runtime.stop();
  });

  it('el reintento arranca en 5 s y no pasa de 5 min', async () => {
    const waits = [];
    const supervisor = startBackgroundLogin({
      login: async () => {
        throw new Error('sin red');
      },
      sleep: async (ms) => { waits.push(ms); },
      shouldStop: () => waits.length >= 8,
      labelCfg: { readerId: 'L1' },
      log: () => {}
    });
    await supervisor.done;
    assert.equal(waits[0], LOGIN_RETRY_MIN_MS);
    assert.equal(waits[0], 5000);
    assert.ok(waits[1] > waits[0]);
    assert.ok(waits.every((ms) => ms <= LOGIN_RETRY_MAX_MS));
    assert.equal(waits[waits.length - 1], LOGIN_RETRY_MAX_MS);
    assert.equal(nextLoginBackoffMs(LOGIN_RETRY_MAX_MS), LOGIN_RETRY_MAX_MS);
  });
});

describe('control de cuelgue de la estación', () => {
  it('reinicia al tercer fallo seguido y se olvida del contador si responde', () => {
    assert.equal(STATION_HEALTH_DEFAULTS.failureThreshold, 3);
    assert.equal(STATION_HEALTH_DEFAULTS.intervalMs, 60_000);
    const first = nextStationHealthState({ consecutiveFailures: 0, responded: false });
    assert.deepEqual(first, { consecutiveFailures: 1, shouldRestart: false });
    const second = nextStationHealthState({
      consecutiveFailures: first.consecutiveFailures,
      responded: false
    });
    assert.deepEqual(second, { consecutiveFailures: 2, shouldRestart: false });
    const third = nextStationHealthState({
      consecutiveFailures: second.consecutiveFailures,
      responded: false
    });
    assert.deepEqual(third, { consecutiveFailures: 0, shouldRestart: true });
    assert.deepEqual(
      nextStationHealthState({ consecutiveFailures: 2, responded: true }),
      { consecutiveFailures: 0, shouldRestart: false }
    );
  });
});
