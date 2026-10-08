'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const k = require('./_hubkit');
const { LanVerifier, signRequest, canonical } = require('./lanSignCompat');
const { sign } = require('./keys');

describe('hub: firma LAN (compat)', () => {
  const keys = k.generateKeyPair();
  const verifier = new LanVerifier({ publicKeyFor: (id) => (id === 'ctl-a' ? keys.publicKeyRaw : null) });

  it('acepta path con query o solo pathname, ts en segundos y firma hex', () => {
    const now = Date.now();
    const h = signRequest({ method: 'GET', path: '/edge/config/chunks', deviceId: 'ctl-a', privateKey: keys.privateKey, now });
    assert.equal(verifier.verify({ method: 'GET', url: '/edge/config/chunks?names=doors', headers: h }).ok, true);
    const tsSec = String(Math.floor(now / 1000));
    const sigHex = Buffer.from(sign(keys.privateKey, canonical('POST', '/edge/events', tsSec, '{}')), 'base64').toString('hex');
    const r = verifier.verify({ method: 'POST', url: '/edge/events', headers: { 'x-mss-device': 'ctl-a', 'x-mss-ts': tsSec, 'x-mss-sig': sigHex }, body: '{}' });
    assert.equal(r.ok, true);
  });

  it('rechaza body alterado, método distinto y falta de headers', () => {
    const h = signRequest({ method: 'POST', path: '/edge/events', body: '{"a":1}', deviceId: 'ctl-a', privateKey: keys.privateKey });
    assert.equal(verifier.verify({ method: 'POST', url: '/edge/events', headers: h, body: '{"a":2}' }).code, 'LAN_SIG_INVALID');
    assert.equal(verifier.verify({ method: 'PUT', url: '/edge/events', headers: h, body: '{"a":1}' }).code, 'LAN_SIG_INVALID');
    assert.equal(verifier.verify({ method: 'GET', url: '/x', headers: {} }).code, 'LAN_SIG_MISSING');
  });
});

describe('hub: estáticos del frontend', { skip: k.SKIP }, () => {
  const dirs = [];
  let built;
  before(async () => {
    const dir = k.tmpDir('lg-hub-static-');
    const www = k.path.join(dir, 'www');
    fs.mkdirSync(k.path.join(www, 'static'), { recursive: true });
    fs.writeFileSync(k.path.join(www, 'index.html'), '<html>guardia</html>');
    fs.writeFileSync(k.path.join(www, 'static', 'app.js'), 'console.log(1)');
    fs.writeFileSync(k.path.join(dir, 'secreto.txt'), 'no');
    dirs.push(dir);
    built = await k.buildHub({ dir, cloud: null, hubKeys: k.generateKeyPair(), extraConfig: { lan: { staticDir: www } } });
  });
  after(async () => {
    await built.hub.stop();
    dirs.forEach(k.rmDir);
  });

  it('sirve archivos, fallback SPA y bloquea path traversal', async () => {
    let res = await fetch(`${built.url}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<html>guardia</html>');
    res = await fetch(`${built.url}/static/app.js`);
    assert.match(res.headers.get('content-type'), /javascript/);
    res = await fetch(`${built.url}/guard/doors`);
    assert.equal(await res.text(), '<html>guardia</html>');
    res = await fetch(`${built.url}/static/nada.js`);
    assert.equal(res.status, 404);
    res = await fetch(`${built.url}/..%2fsecreto.txt`);
    assert.notEqual(await res.text(), 'no');
    res = await fetch(`${built.url}/edge/status`);
    const st = await res.json();
    assert.equal(st.role, 'hub');
    assert.equal(st.cloudOnline, null, 'sin nube configurada: modo solo-LAN');
  });
});
