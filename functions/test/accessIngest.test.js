const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRawDataFromIngest,
  normalizeAccessIngestRequest
} = require('../lib/accessIngest');
const { detectAuthMethod } = require('../lib/accessAuthMethods');

describe('accessIngest', () => {
  it('arma CARD# y BIO# desde identity', () => {
    assert.equal(
      buildRawDataFromIngest({ authMethod: 'credential', credentialCode: 'aabb11' }),
      'CARD#aabb11'
    );
    assert.equal(
      buildRawDataFromIngest({ authMethod: 'biometric', biometricExternalId: 'EMP-9' }),
      'BIO#EMP-9'
    );
  });

  it('detectAuthMethod entiende BIO#', () => {
    const d = detectAuthMethod('BIO#ZK-100');
    assert.equal(d.method, 'biometric');
    assert.equal(d.payload, 'ZK-100');
  });

  it('normalizeAccessIngestRequest exige datos', () => {
    const bad = normalizeAccessIngestRequest({}, 'u1');
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
  });

  it('normalizeAccessIngestRequest acepta body de kiosk legado', () => {
    const ok = normalizeAccessIngestRequest({
      rawData: '30111222',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1'
    }, 'guard1');
    assert.equal(ok.ok, true);
    assert.equal(ok.args.rawData, '30111222');
    assert.equal(ok.args.doorId, 'puerta-p1');
    assert.equal(ok.args.readerId, 'INGRESO_P1');
  });
});
