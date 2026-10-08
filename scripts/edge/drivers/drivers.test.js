'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const {
  createReader, createOutput, createInput, frameToCredential, normalizeInputValue, serialFramer, inputs
} = require('./index');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('drivers: lectores', () => {
  it('frameToCredential: PDF417, número, QR, tarjeta y BioStar', () => {
    const pdf = '00512345678@PEREZ@JUAN@M@30111222@B@01/01/1980@01/01/2020';
    assert.deepEqual(
      { type: frameToCredential(pdf).type, value: frameToCredential(pdf).value, format: frameToCredential(pdf).format },
      { type: 'dni', value: '30111222', format: 'pdf417' }
    );
    assert.equal(frameToCredential('30111222').value, '30111222');
    assert.equal(frameToCredential('DNI:30.111.222').value, '30111222');
    assert.deepEqual([frameToCredential('QR:qr_abc').type, frameToCredential('QR:qr_abc').value], ['qr', 'qr_abc']);
    assert.equal(frameToCredential('pase-xyz').type, 'qr');
    assert.equal(frameToCredential('pase-xyz', { credentialType: 'dni' }), null);
    assert.deepEqual([frameToCredential('CARD#00ab12').type, frameToCredential('CARD#00ab12').value], ['card', '00ab12']);
    assert.equal(frameToCredential('BIO#77').type, 'biostar');
    assert.equal(frameToCredential('   '), null);
  });

  it('framer: corta por CR/LF y por silencio', async () => {
    const frames = [];
    const f = serialFramer.createSerialFramer({ idleMs: 20 }, (fr) => frames.push(fr));
    f.push(Buffer.from('3011'));
    f.push(Buffer.from('1222\r\n4455'));
    assert.deepEqual(frames.map((x) => [x.text, x.reason]), [['30111222', 'CRLF']]);
    await tick(40);
    assert.deepEqual(frames.map((x) => x.text), ['30111222', '4455']);
    f.destroy();
  });

  it('stdin: entrega credenciales con lector y lado', async () => {
    const stream = new PassThrough();
    const r = createReader({ id: 'lec-in', driver: 'stdin', side: 'in', idleMs: 20 }, { stream });
    const got = [];
    await r.start((c) => got.push(c));
    stream.write('30111222\n');
    stream.write('basura-sin-sentido\n');
    await tick(5);
    await r.stop();
    assert.equal(got.length, 2);
    assert.deepEqual([got[0].type, got[0].value, got[0].readerId, got[0].side], ['dni', '30111222', 'lec-in', 'in']);
    assert.equal(r.health().credentials, 2);
  });

  it('wiegand: interfaz presente, avisa fase 2', async () => {
    const r = createReader({ id: 'w', driver: 'wiegand' });
    await r.start(() => {});
    assert.match(r.health().error, /fase 2/);
  });
});

describe('drivers: salidas', () => {
  it('sr201: ON, OFF a los ms y reintento del OFF', async () => {
    const sent = [];
    let offFails = 1;
    const sendFn = async (host, port, cmd) => {
      sent.push(cmd);
      if (cmd.startsWith('2') && offFails > 0) {
        offFails -= 1;
        throw new Error('ECONNRESET');
      }
      return { command: cmd, response: '10000000', confirmed: true };
    };
    const out = createOutput({ driver: 'sr201', host: '192.168.0.38', port: 6722, channel: 1, offRetryDelaysMs: [5, 5], minPulseMs: 1 }, { sendFn, sleepFn: tick });
    const r = await out.pulse(30);
    assert.deepEqual(r.ok, true);
    assert.equal(r.relayConfirmed, true);
    assert.deepEqual(sent, ['11']);
    await tick(80);
    assert.deepEqual(sent, ['11', '21', '21']);
    assert.equal(out.health().active, false);
  });

  it('sr201: ON que falla → ok=false; sin respuesta → relayConfirmed=false', async () => {
    const down = createOutput({ driver: 'sr201', host: '10.0.0.9' }, { sendFn: async () => { throw new Error('EHOSTUNREACH'); } });
    const r1 = await down.pulse(1000);
    assert.equal(r1.ok, false);
    assert.match(r1.error, /EHOSTUNREACH/);
    const mute = createOutput({ driver: 'sr201', host: '10.0.0.9', offRetryDelaysMs: [], minPulseMs: 1 }, { sendFn: async (h, p, cmd) => ({ command: cmd, response: null, confirmed: false }) });
    const r2 = await mute.pulse(10);
    assert.equal(r2.ok, true);
    assert.equal(r2.relayConfirmed, false);
    await tick(30);
    await mute.stop();
  });

  it('sr201: set(true) mantiene (emergencia) y lock() re-traba antes de tiempo', async () => {
    const sent = [];
    const sendFn = async (h, p, cmd) => { sent.push(cmd); return { confirmed: true, response: 'x' }; };
    const out = createOutput({ driver: 'sr201', host: '192.168.0.38', channel: 2, minPulseMs: 1 }, { sendFn, sleepFn: tick });
    await out.set(true);
    await out.pulse(10);
    await tick(30);
    assert.deepEqual(sent, ['12', '12'], 'retenido: el pulso no apaga');
    await out.set(false);
    assert.deepEqual(sent, ['12', '12', '22']);
    await out.pulse(5000);
    await out.lock();
    assert.deepEqual(sent.slice(-2), ['12', '22']);
    await out.stop();
  });

  it('generic_http: pulse/on/off', async () => {
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const out = createOutput({ driver: 'generic_http', httpUrl: 'http://relay.local/x' }, { fetchFn });
    assert.equal((await out.pulse(3000)).relayConfirmed, true);
    await out.set(true);
    await out.set(false);
    assert.deepEqual(calls.map((c) => c.action), ['pulse', 'on', 'off']);
    assert.equal(calls[0].seconds, 3);
    const bad = createOutput({ driver: 'generic_http', httpUrl: 'http://relay.local/x' }, {
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) })
    });
    assert.equal((await bad.pulse(1000)).ok, false);
  });

  it('gpio: en Windows (o mock) no toca hardware', async () => {
    const out = createOutput({ driver: 'gpio', line: 17, mock: true });
    const r = await out.pulse(10);
    assert.equal(r.ok, true);
    assert.equal(r.detail.mock, true);
    await out.stop();
  });
});

describe('drivers: entradas', () => {
  it('normalizeInputValue', () => {
    assert.equal(normalizeInputValue('dps', true), 'open');
    assert.equal(normalizeInputValue('dps', 'cerrada'), 'closed');
    assert.equal(normalizeInputValue('bond', 1), 'engaged');
    assert.equal(normalizeInputValue('bond', 'released'), 'released');
    assert.equal(normalizeInputValue('rex', 'on'), true);
    assert.equal(normalizeInputValue('emergency', false), false);
    assert.equal(normalizeInputValue('dps', 'quizás'), undefined);
  });

  it('simulated: estado inicial, cambios y validación', async () => {
    const inp = createInput({ driver: 'simulated', dps: true, bond: false, rex: true, emergency: true });
    const seen = [];
    await inp.start((n, v) => seen.push([n, v]));
    assert.deepEqual(seen, [['dps', 'closed'], ['rex', false], ['emergency', false]]);
    assert.equal(inp.set('dps', 'open').ok, true);
    assert.equal(inp.set('dps', 'open').ok, true, 'repetido: sin evento');
    assert.equal(inp.set('bond', true).ok, false, 'bond no configurado');
    assert.equal(inp.set('dps', 'x').ok, false);
    assert.deepEqual(seen.at(-1), ['dps', 'open']);
    assert.equal(seen.length, 4);
  });

  it('gpiomon: parseo de formatos v1/v2 y clásico', () => {
    assert.deepEqual(inputs.parseGpiomonLine('17 1', 1), { offset: 17, rising: true });
    assert.deepEqual(inputs.parseGpiomonLine('17 0', 1), { offset: 17, rising: false });
    assert.deepEqual(inputs.parseGpiomonLine('22 2', 2), { offset: 22, rising: false });
    assert.deepEqual(inputs.parseGpiomonLine('event:  RISING EDGE offset: 23 timestamp: [1.2]'), { offset: 23, rising: true });
    assert.equal(inputs.parseGpiomonLine('basura'), null);
  });

  it('gpio input: mapea línea → entrada con activeLow', () => {
    const inp = createInput({ driver: 'gpio', mock: true, dps: { line: 17 }, rex: { line: 22, activeLow: true } });
    const seen = [];
    inp.onChange = (n, v) => seen.push([n, v]);
    inp.handleLine('17 1');
    inp.handleLine('22 0');
    inp.handleLine('99 1');
    assert.deepEqual(seen, [['dps', 'open'], ['rex', true]]);
  });
});
