const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Tests livianos del contrato de cola (sin Firestore real).
 * Validamos forma de payload vía una función local espejo de sanitize.
 */
const sanitizeQueuedRelay = (localRelay = {}) => {
  const driver = localRelay?.driver === 'generic_http' ? 'generic_http' : 'sr201';
  const pulseMode = localRelay.pulseMode === 'jog' ? 'jog' : 'timed';
  const pulseSeconds = Math.max(1, Math.min(99, Number(localRelay.pulseSeconds) || 3));
  if (driver === 'generic_http') {
    const httpUrl = String(localRelay?.httpUrl || '').trim();
    if (!httpUrl) return null;
    return {
      driver,
      host: '',
      port: 0,
      channel: 1,
      pulseMode,
      pulseSeconds,
      httpUrl,
      httpMethod: String(localRelay.httpMethod || 'POST').toUpperCase(),
      httpAuthToken: String(localRelay.httpAuthToken || '')
    };
  }
  const host = String(localRelay?.host || '').trim();
  if (!host) return null;
  return {
    driver: 'sr201',
    host,
    port: Number(localRelay.port) || 6722,
    channel: Number(localRelay.channel) === 2 ? 2 : 1,
    pulseMode,
    pulseSeconds,
    httpUrl: '',
    httpMethod: 'POST',
    httpAuthToken: ''
  };
};

describe('pending local open payload', () => {
  it('normaliza host/canal/segundos', () => {
    assert.deepEqual(
      sanitizeQueuedRelay({ host: '192.168.0.38', channel: 2, pulseSeconds: 5 }),
      {
        driver: 'sr201',
        host: '192.168.0.38',
        port: 6722,
        channel: 2,
        pulseMode: 'timed',
        pulseSeconds: 5,
        httpUrl: '',
        httpMethod: 'POST',
        httpAuthToken: ''
      }
    );
  });

  it('sin host → null (no encolar)', () => {
    assert.equal(sanitizeQueuedRelay({ channel: 1 }), null);
  });

  it('acepta HTTP genérico con httpUrl', () => {
    const payload = sanitizeQueuedRelay({
      driver: 'generic_http',
      httpUrl: 'http://192.168.0.50/open',
      httpMethod: 'POST',
      pulseSeconds: 3
    });
    assert.equal(payload.driver, 'generic_http');
    assert.equal(payload.httpUrl, 'http://192.168.0.50/open');
  });
});
