'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const lanSign = require('../lib/lanSign');

describe('lanSign (firma Ed25519 LAN)', () => {
  const hub = lanSign.generateKeyPair();
  const other = lanSign.generateKeyPair();
  const now = 1_760_000_000_000;
  const body = JSON.stringify({ requestedBy: 'guardia1', reason: 'prueba' });

  const signed = (extra = {}) => lanSign.signRequest({
    privateKey: hub.privateKeyPem, keyId: 'hub-1', method: 'POST', path: '/edge/doors/p1/open', body, now, ...extra
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
    assert.equal(verify(h, { body: body.replace('prueba', 'otra') }).code, 'SIG_INVALID');
    assert.equal(verify(h, { path: '/edge/doors/p2/open' }).code, 'SIG_INVALID');
    assert.equal(verify(h, { method: 'GET' }).code, 'SIG_INVALID');
  });

  it('rechaza clave desconocida, firma de otra clave y faltantes', () => {
    assert.equal(verify(signed({ keyId: 'intruso' })).code, 'SIG_UNKNOWN_KEY');
    const forged = lanSign.signRequest({ privateKey: other.privateKeyPem, keyId: 'hub-1', method: 'POST', path: '/edge/doors/p1/open', body, now });
    assert.equal(verify(forged).code, 'SIG_INVALID');
    assert.equal(verify({}).code, 'SIG_MISSING');
  });

  it('ventana de 60 s y anti-replay', () => {
    assert.equal(verify(signed({ now: now - 61_000 })).code, 'SIG_EXPIRED');
    assert.equal(verify(signed({ now: now + 59_000 })).ok, true);
    const store = lanSign.createNonceStore();
    const h = signed();
    assert.equal(verify(h, { nonceStore: store }).ok, true);
    assert.equal(verify(h, { nonceStore: store }).code, 'SIG_REPLAY');
  });

  it('firma del head de la nube (con rotación por keyId)', () => {
    const cloud = lanSign.generateKeyPair();
    const head = lanSign.signHead({ version: 7, chunks: { doors: { v: 7, hash: 'abc' } } }, cloud.privateKeyPem, 'k1');
    assert.equal(lanSign.verifyHead(head, cloud.publicKeyB64), true);
    assert.equal(lanSign.verifyHead(head, { k1: cloud.publicKeyPem }), true);
    assert.equal(lanSign.verifyHead(head, { k2: cloud.publicKeyPem }), false);
    assert.equal(lanSign.verifyHead({ ...head, version: 8 }, cloud.publicKeyB64), false);
    assert.equal(lanSign.verifyHead({ ...head, sig: undefined }, cloud.publicKeyB64), false);
    assert.equal(lanSign.verifyHead(head, hub.publicKeyB64), false);
  });
});
