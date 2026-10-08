'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const lanSign = require('../lib/lanSign');

const HUB_DIR = path.join(__dirname, '..', 'hub');
const hasHub = fs.existsSync(path.join(HUB_DIR, 'lanSignCompat.js')) && fs.existsSync(path.join(HUB_DIR, 'headSignature.js'));

describe('lanSign (firma Ed25519 LAN)', () => {
  const hub = lanSign.generateKeyPair();
  const other = lanSign.generateKeyPair();
  const now = 1_760_000_000_000;
  const body = JSON.stringify({ requestedBy: 'guardia1', reason: 'prueba' });

  const signed = (extra = {}) => lanSign.signRequest({
    privateKey: hub.privateKeyPem, deviceId: 'hub-1', method: 'POST', path: '/edge/doors/p1/open', body, now, ...extra
  });
  const verify = (headers, extra = {}) => lanSign.verifyRequest({
    method: 'POST', path: '/edge/doors/p1/open', headers, body, now,
    resolveKey: (id) => (id === 'hub-1' ? hub.publicKeyB64 : null), ...extra
  });

  it('firma y verifica (PEM, base64 crudo y KeyObject)', () => {
    assert.equal(verify(signed()).ok, true);
    assert.equal(verify(signed(), { resolveKey: () => hub.publicKeyPem }).ok, true);
    assert.equal(verify(signed(), { resolveKey: () => hub.publicKey }).ok, true);
    assert.equal(lanSign.publicKeyRawB64(hub.privateKeyPem), hub.publicKeyB64);
  });

  it('rechaza body, path o método alterados', () => {
    const h = signed();
    assert.equal(verify(h, { body: body.replace('prueba', 'otra') }).code, 'LAN_SIG_INVALID');
    assert.equal(verify(h, { path: '/edge/doors/p2/open' }).code, 'LAN_SIG_INVALID');
    assert.equal(verify(h, { method: 'PUT' }).code, 'LAN_SIG_INVALID');
  });

  it('rechaza equipo desconocido, firma de otra clave y faltantes', () => {
    assert.equal(verify(signed({ deviceId: 'intruso' })).code, 'DEVICE_NOT_ENROLLED');
    const forged = lanSign.signRequest({ privateKey: other.privateKeyPem, deviceId: 'hub-1', method: 'POST', path: '/edge/doors/p1/open', body, now });
    assert.equal(verify(forged).code, 'LAN_SIG_INVALID');
    assert.equal(verify({}).code, 'LAN_SIG_MISSING');
  });

  it('ventana de 60 s, ts en segundos y anti-replay en no-GET', () => {
    assert.equal(verify(signed({ now: now - 61_000 })).code, 'LAN_SIG_EXPIRED');
    assert.equal(verify(signed({ now: now + 59_000 })).ok, true);
    const store = lanSign.createNonceStore();
    const h = signed();
    assert.equal(verify(h, { nonceStore: store }).ok, true);
    assert.equal(verify(h, { nonceStore: store }).code, 'LAN_SIG_REPLAY');
    const g = lanSign.signRequest({ privateKey: hub.privateKeyPem, deviceId: 'hub-1', method: 'GET', path: '/edge/status', now });
    const vg = () => lanSign.verifyRequest({ method: 'GET', path: '/edge/status', headers: g, now, nonceStore: store, resolveKey: () => hub.publicKeyB64 });
    assert.equal(vg().ok, true);
    assert.equal(vg().ok, true, 'GET repetido se tolera (solo lectura)');
  });

  it('acepta la firma hecha sobre el pathname aunque la request traiga query', () => {
    const h = lanSign.signRequest({ privateKey: hub.privateKeyPem, deviceId: 'hub-1', method: 'GET', path: '/edge/config/chunks', now });
    assert.equal(lanSign.verifyRequest({ method: 'GET', path: '/edge/config/chunks?names=doors', headers: h, now, resolveKey: () => hub.publicKeyB64 }).ok, true);
  });

  it('firma del head de la nube = {version, chunks} (con rotación por keyId)', () => {
    const cloud = lanSign.generateKeyPair();
    const head = lanSign.signHead({ version: 7, chunks: { doors: { v: 7, hash: 'abc' } }, generatedAt: 123 }, cloud.privateKeyPem, 'k1');
    assert.equal(lanSign.verifyHead(head, cloud.publicKeyB64), true);
    assert.equal(lanSign.verifyHead(head, { k1: cloud.publicKeyPem }), true);
    assert.equal(lanSign.verifyHead({ ...head, generatedAt: 999 }, { k1: cloud.publicKeyPem }), true, 'campos extra no firmados');
    assert.equal(lanSign.verifyHead(head, { k2: cloud.publicKeyPem }), false);
    assert.equal(lanSign.verifyHead({ ...head, version: 8 }, cloud.publicKeyB64), false);
    assert.equal(lanSign.verifyHead({ ...head, sig: undefined }, cloud.publicKeyB64), false);
    assert.equal(lanSign.verifyHead(head, hub.publicKeyB64), false);
  });
});

describe('lanSign ⇄ hub (interoperabilidad con lanSignCompat / headSignature)', { skip: hasHub ? false : 'sin scripts/edge/hub' }, () => {
  it('el hub verifica lo que firma el controlador y viceversa; mismo head', () => {
    const compat = require('../hub/lanSignCompat');
    const { makeHeadVerifier } = require('../hub/headSignature');
    const ctl = lanSign.generateKeyPair();
    const hubKp = lanSign.generateKeyPair();
    const body = JSON.stringify({ deviceId: 'ctl-1', events: [] });

    const fromCtl = lanSign.signRequest({ privateKey: ctl.privateKeyPem, deviceId: 'ctl-1', method: 'POST', path: '/edge/events', body });
    const hubVerifier = new compat.LanVerifier({ publicKeyFor: (id) => (id === 'ctl-1' ? ctl.publicKeyB64 : null) });
    assert.deepEqual(hubVerifier.verify({ method: 'POST', url: '/edge/events', headers: fromCtl, body }), { ok: true, deviceId: 'ctl-1' });

    const notify = JSON.stringify({ version: 3 });
    const fromHub = compat.signRequest({ method: 'POST', path: '/edge/config/notify', body: notify, deviceId: 'hub-1', privateKey: hubKp.privateKeyPem });
    assert.equal(lanSign.verifyRequest({ method: 'POST', path: '/edge/config/notify', headers: fromHub, body: notify, resolveKey: () => hubKp.publicKeyB64 }).ok, true);

    const cloud = lanSign.generateKeyPair();
    const head = lanSign.signHead({ version: 5, chunks: { doors: { v: 5, hash: 'x' } } }, cloud.privateKeyPem, 'k1');
    assert.equal(makeHeadVerifier({ k1: cloud.publicKeyB64 })(head), true);
  });
});
