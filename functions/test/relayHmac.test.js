const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  WINDOW_SECONDS,
  createNonceStore,
  buildCanonicalString,
  signRelayRequest,
  verifyRelayRequest,
  authorizePulseRequest
} = require('../lib/relayHmac');

const SECRET = 'bridge-secret-de-prueba';
const BODY = '{"channel":1,"mode":"timed","seconds":3}';

describe('relayHmac helper puro', () => {
  it('firma y verifica el mismo body+timestamp+nonce', () => {
    const signed = signRelayRequest({
      secret: SECRET,
      timestamp: '1700000000',
      nonce: 'aa'.repeat(16),
      body: BODY
    });
    const nowMs = 1700000000 * 1000;
    const result = verifyRelayRequest({
      secret: SECRET,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
      signature: signed.signature,
      body: BODY,
      nowMs
    });
    assert.equal(result.ok, true);
  });

  it('el canónico incluye método, path, ts, nonce y hash del body', () => {
    const canonical = buildCanonicalString({
      method: 'POST',
      path: '/pulse',
      timestamp: '1',
      nonce: 'n1',
      body: '{}'
    });
    assert.match(canonical, /^POST\n\/pulse\n1\nn1\n[0-9a-f]{64}$/);
  });

  it('body distinto o secreto distinto → firma inválida', () => {
    const signed = signRelayRequest({ secret: SECRET, timestamp: '1700000000', nonce: 'n', body: BODY });
    const nowMs = 1700000000 * 1000;
    assert.equal(verifyRelayRequest({
      secret: SECRET,
      ...signed,
      body: '{"channel":2}',
      nowMs
    }).code, 'bad_signature');
    assert.equal(verifyRelayRequest({
      secret: 'otra',
      ...signed,
      body: BODY,
      nowMs
    }).code, 'bad_signature');
  });

  it(`rechaza timestamp fuera de ±${WINDOW_SECONDS}s`, () => {
    const ts = 1700000000;
    const signed = signRelayRequest({ secret: SECRET, timestamp: String(ts), nonce: 'n', body: BODY });
    assert.equal(verifyRelayRequest({
      secret: SECRET,
      ...signed,
      body: BODY,
      nowMs: (ts + WINDOW_SECONDS + 1) * 1000
    }).code, 'expired');
  });

  it('sin headers HMAC → missing_hmac', () => {
    assert.equal(verifyRelayRequest({
      secret: SECRET,
      body: BODY,
      nowMs: Date.now()
    }).code, 'missing_hmac');
  });
});

describe('relayHmac — rechazo de replay en el puente', () => {
  it('la segunda petición con el mismo nonce es replay (401)', () => {
    const seenNonces = createNonceStore();
    const nowMs = 1700000000 * 1000;
    const signed = signRelayRequest({
      secret: SECRET,
      timestamp: '1700000000',
      nonce: 'nonce-unico-1',
      body: BODY
    });
    const headers = {
      authorization: `Bearer ${SECRET}`,
      'x-mss-timestamp': signed.timestamp,
      'x-mss-nonce': signed.nonce,
      'x-mss-signature': signed.signature
    };

    const first = authorizePulseRequest({
      secret: SECRET,
      headers,
      rawBody: BODY,
      nowMs,
      seenNonces
    });
    assert.equal(first.ok, true);

    const replay = authorizePulseRequest({
      secret: SECRET,
      headers,
      rawBody: BODY,
      nowMs: nowMs + 1000,
      seenNonces
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 401);
    assert.equal(replay.code, 'replay');
  });

  it('Bearer malo no llega a firmar y no abre', () => {
    const signed = signRelayRequest({ secret: SECRET, timestamp: '1700000000', nonce: 'n', body: BODY });
    const result = authorizePulseRequest({
      secret: SECRET,
      headers: {
        authorization: 'Bearer no',
        'x-mss-timestamp': signed.timestamp,
        'x-mss-nonce': signed.nonce,
        'x-mss-signature': signed.signature
      },
      rawBody: BODY,
      nowMs: 1700000000 * 1000,
      seenNonces: createNonceStore()
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bearer');
  });

  it('excepción de cálculo no es fail-open: sin firma → 401', () => {
    const result = authorizePulseRequest({
      secret: SECRET,
      headers: { authorization: `Bearer ${SECRET}` },
      rawBody: BODY,
      nowMs: Date.now(),
      seenNonces: createNonceStore()
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.code, 'missing_hmac');
  });
});
