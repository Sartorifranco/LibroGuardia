/**
 * Puente SR201 (scripts/programa-apertura-internet.js) + driver: fail-closed.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  authorizePulseRequest,
  checkBridgeSecretStrength,
  isBearerAuthorized,
  signRelayRequest,
  createNonceStore
} = require('../lib/relayHmac');
const {
  sendOffWithRetry,
  sendTimedPulseTcp,
  buildOffCommand
} = require('../lib/doorDrivers/sr201');
const { describeRelayConfirmation } = require('../doorController');
const bridge = require('../../scripts/programa-apertura-internet');

const SECRET = 'clave-larga-de-prueba-1234';
const quietLogger = { warn() {}, error() {}, log() {} };

const settingsFor = (overrides = {}) => bridge.resolveBridgeSettings({
  fileCfg: {
    sr201Host: '192.168.0.38',
    sr201Port: 6722,
    bridgeSecret: SECRET,
    ...overrides
  },
  configPath: 'C:/planta/scripts/configuracion-apertura-internet.json',
  env: {}
});

const signedHeaders = (body, nowSec = Math.floor(Date.now() / 1000)) => {
  const signed = signRelayRequest({ secret: SECRET, body, timestamp: String(nowSec) });
  return { authorization: `Bearer ${SECRET}`, ...signed.headers, 'x-mss-timestamp': signed.timestamp, 'x-mss-nonce': signed.nonce, 'x-mss-signature': signed.signature };
};

const fakeDeps = () => {
  const calls = [];
  return {
    calls,
    deps: {
      sendTcpCommand: async (host, port, command) => {
        calls.push({ fn: 'sendTcpCommand', host, port, command });
        return { command, response: '10000000', confirmed: true };
      },
      sendTimedPulseTcp: async (host, port, channel, seconds, _t, options) => {
        calls.push({ fn: 'sendTimedPulseTcp', host, port, channel, seconds, options });
        return { command: `1${channel} / wait ${seconds}s / 2${channel}`, mode: 'timed', seconds, async: true, confirmed: true };
      },
      queryRelayStatusTcp: async (host, port) => {
        calls.push({ fn: 'queryRelayStatusTcp', host, port });
        return { raw: '00000000', channels: {}, host, port };
      }
    }
  };
};

describe('relayHmac fail-closed', () => {
  it('sin secreto configurado /pulse se rechaza (antes pasaba sin auth)', () => {
    const result = authorizePulseRequest({ secret: '', headers: {}, rawBody: '{}' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'missing_secret');
    assert.equal(isBearerAuthorized('', { authorization: 'Bearer ' }), false);
  });

  it('fortaleza del secreto: vacío, ejemplo y corto se rechazan', () => {
    assert.equal(checkBridgeSecretStrength('').code, 'missing_secret');
    assert.equal(checkBridgeSecretStrength('CAMBIAR-SECRETO').code, 'placeholder_secret');
    assert.deepEqual(checkBridgeSecretStrength('abc123'), { ok: false, code: 'short_secret', length: 6 });
    assert.equal(checkBridgeSecretStrength('a'.repeat(16)).ok, true);
  });
});

describe('puente: arranque', () => {
  it('secreto corto → error que dice qué cambiar y en qué archivo, sin mostrar el secreto', () => {
    const settings = settingsFor({ bridgeSecret: 'abc123' });
    const errors = bridge.validateBridgeSettings(settings);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /configuracion-apertura-internet\.json/);
    assert.match(errors[0], /bridgeSecret/);
    assert.match(errors[0], /6 caracteres/);
    assert.match(errors[0], /16/);
    assert.match(errors[0], /Clave de seguridad/);
    assert.ok(!errors[0].includes('abc123'), 'nunca imprimir el secreto');
  });

  it('sin secreto → no arranca', () => {
    const errors = bridge.validateBridgeSettings(settingsFor({ bridgeSecret: '' }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Falta la clave/);
  });

  it('secreto válido → sin errores', () => {
    assert.deepEqual(bridge.validateBridgeSettings(settingsFor()), []);
  });
});

describe('puente: /pulse', () => {
  it('sin secreto en settings responde error y no pulsa', async () => {
    const { calls, deps } = fakeDeps();
    const out = await bridge.handlePulse({
      settings: settingsFor({ bridgeSecret: '' }),
      headers: {},
      rawBody: '{"channel":1}',
      nonces: createNonceStore(),
      deps
    });
    assert.notEqual(out.status, 200);
    assert.equal(calls.length, 0);
  });

  it('ignora `command` del body: arma el pulso solo con canal + modo', async () => {
    const { calls, deps } = fakeDeps();
    const body = JSON.stringify({ channel: 2, mode: 'jog', command: '21' /* OFF / arbitrario */ });
    const out = await bridge.handlePulse({
      settings: settingsFor(),
      headers: signedHeaders(body),
      rawBody: body,
      nonces: createNonceStore(),
      deps
    });
    assert.equal(out.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '12*');
    assert.equal(calls[0].host, '192.168.0.38');
  });

  it('host fuera de la lista permitida → 403 y no pulsa', async () => {
    const { calls, deps } = fakeDeps();
    const body = JSON.stringify({ channel: 1, mode: 'timed', seconds: 3, host: '10.0.0.99', port: 6722 });
    const out = await bridge.handlePulse({
      settings: settingsFor(),
      headers: signedHeaders(body),
      rawBody: body,
      nonces: createNonceStore(),
      deps
    });
    assert.equal(out.status, 403);
    assert.match(out.body.message, /sr201Permitidos/);
    assert.equal(calls.length, 0);
  });

  it('host en sr201Permitidos → pulsa timed en ese destino', async () => {
    const { calls, deps } = fakeDeps();
    const body = JSON.stringify({ channel: 1, mode: 'timed', seconds: 4, host: '192.168.0.40', port: 6722 });
    const out = await bridge.handlePulse({
      settings: settingsFor({ sr201Permitidos: ['192.168.0.40:6722'] }),
      headers: signedHeaders(body),
      rawBody: body,
      nonces: createNonceStore(),
      deps
    });
    assert.equal(out.status, 200);
    assert.equal(calls[0].fn, 'sendTimedPulseTcp');
    assert.equal(calls[0].host, '192.168.0.40');
    assert.equal(calls[0].seconds, 4);
    assert.equal(calls[0].options.waitForComplete, false);
  });

  it('puerto distinto al permitido también se rechaza', async () => {
    const { calls, deps } = fakeDeps();
    const body = JSON.stringify({ channel: 1, host: '192.168.0.38', port: 22 });
    const out = await bridge.handlePulse({
      settings: settingsFor(),
      headers: signedHeaders(body),
      rawBody: body,
      nonces: createNonceStore(),
      deps
    });
    assert.equal(out.status, 403);
    assert.equal(calls.length, 0);
  });
});

describe('puente: /status y /health', () => {
  it('/status sin Bearer → 401; con host no permitido → 403', async () => {
    const { calls, deps } = fakeDeps();
    const settings = settingsFor();
    const noAuth = await bridge.handleStatus({ settings, headers: {}, params: {}, deps });
    assert.equal(noAuth.status, 401);
    const foreign = await bridge.handleStatus({
      settings,
      headers: { authorization: `Bearer ${SECRET}` },
      params: { host: '10.1.1.1', port: 6722 },
      deps
    });
    assert.equal(foreign.status, 403);
    assert.equal(calls.length, 0);
    const ok = await bridge.handleStatus({
      settings,
      headers: { authorization: `Bearer ${SECRET}` },
      params: {},
      deps
    });
    assert.equal(ok.status, 200);
    assert.equal(calls[0].host, '192.168.0.38');
  });

  it('/status sin secreto configurado → 401 aunque manden "Bearer "', async () => {
    const { deps } = fakeDeps();
    const out = await bridge.handleStatus({
      settings: settingsFor({ bridgeSecret: '' }),
      headers: { authorization: 'Bearer ' },
      params: {},
      deps
    });
    assert.equal(out.status, 401);
  });

  it('/health no expone IP ni puerto de la placa', () => {
    const out = bridge.handleHealth();
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'ok');
    const text = JSON.stringify(out.body);
    assert.ok(!/192\.168|6722|sr201Host|sr201Port/.test(text));
  });
});

describe('sr201: OFF con reintentos y "sin confirmación"', () => {
  it('si el OFF falla se reintenta hasta confirmar', async () => {
    const sent = [];
    const waits = [];
    let n = 0;
    const res = await sendOffWithRetry('192.168.0.38', 6722, 1, {
      sendFn: async (_h, _p, cmd) => {
        sent.push(cmd);
        n += 1;
        if (n < 3) throw new Error('ECONNRESET');
        return { command: cmd, response: '00000000', confirmed: true };
      },
      sleepFn: async (ms) => { waits.push(ms); },
      logger: quietLogger
    });
    assert.equal(res.ok, true);
    assert.equal(res.confirmed, true);
    assert.equal(res.attempts, 3);
    assert.deepEqual(sent, [buildOffCommand(1), buildOffCommand(1), buildOffCommand(1)]);
    assert.deepEqual(waits, [300, 1000]);
  });

  it('si nunca confirma: 4 intentos (300 ms / 1 s / 3 s) y alerta fuerte', async () => {
    const waits = [];
    const errors = [];
    const res = await sendOffWithRetry('192.168.0.38', 6722, 2, {
      sendFn: async () => { throw new Error('timeout'); },
      sleepFn: async (ms) => { waits.push(ms); },
      logger: { warn() {}, error: (msg) => errors.push(msg) }
    });
    assert.equal(res.confirmed, false);
    assert.equal(res.attempts, 4);
    assert.deepEqual(waits, [300, 1000, 3000]);
    assert.ok(errors.some((m) => /DESTRABADA/.test(m)));
  });

  it('OFF sin respuesta de la placa también se reintenta', async () => {
    let n = 0;
    const res = await sendOffWithRetry('h', 1, 1, {
      sendFn: async (_h, _p, cmd) => {
        n += 1;
        return n === 1 ? { command: cmd, response: null, confirmed: false } : { command: cmd, response: '0', confirmed: true };
      },
      sleepFn: async () => {},
      logger: quietLogger
    });
    assert.equal(res.confirmed, true);
    assert.equal(res.attempts, 2);
  });

  it('pulso timed: ON sin respuesta se informa confirmed=false; OFF reintentado tras N s', async () => {
    const sent = [];
    const waits = [];
    let offFails = 1;
    const result = await sendTimedPulseTcp('192.168.0.38', 6722, 1, 3, 1000, {
      waitForComplete: true,
      sendFn: async (_h, _p, cmd) => {
        sent.push(cmd);
        if (cmd === '11') return { command: cmd, response: null, confirmed: false };
        if (offFails > 0) { offFails -= 1; throw new Error('reset'); }
        return { command: cmd, response: '00000000', confirmed: true };
      },
      sleepFn: async (ms) => { waits.push(ms); },
      logger: quietLogger
    });
    assert.deepEqual(sent, ['11', '21', '21']);
    assert.deepEqual(waits, [3000, 300]);
    assert.equal(result.confirmed, false, 'ON sin confirmación no es éxito pleno');
    assert.equal(result.offConfirmed, true);
  });

  it('temporizador nativo opcional: ON como "1R:n"', async () => {
    const sent = [];
    await sendTimedPulseTcp('h', 6722, 2, 5, 1000, {
      waitForComplete: true,
      nativeTimer: true,
      sendFn: async (_h, _p, cmd) => { sent.push(cmd); return { command: cmd, response: 'x', confirmed: true }; },
      sleepFn: async () => {},
      logger: quietLogger
    });
    assert.deepEqual(sent, ['12:5', '22']);
  });

  it('auditoría: confirmed=false se registra como sin_confirmacion', () => {
    assert.deepEqual(describeRelayConfirmation({ via: 'tcp', confirmed: false }), {
      relayConfirmed: false,
      relayStatus: 'sin_confirmacion'
    });
    assert.equal(describeRelayConfirmation({ via: 'bridge', confirmed: true }).relayStatus, 'confirmado');
    assert.equal(describeRelayConfirmation({ via: 'bridge' }).relayStatus, 'desconocido');
    assert.equal(describeRelayConfirmation({ via: 'local-queue' }).relayStatus, 'en_cola');
  });
});
