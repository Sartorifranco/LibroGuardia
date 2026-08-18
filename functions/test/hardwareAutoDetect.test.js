const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

describe('hardwareAutoDetect sequential short-circuit', () => {
  it('con Hikvision high no llama BioStar ni ZK', async () => {
    const auto = require(path.join(__dirname, '../../scripts/lib/hardwareAutoDetect.js'));
    const calls = [];
    const result = await auto.runHardwareAutoDetect(
      { host: '192.168.0.1' },
      {
        probeHikvision: async () => {
          calls.push('hik');
          return {
            vendor: 'hikvision',
            ok: true,
            ms: 10,
            candidate: {
              brandId: 'hikvision',
              stationPlugin: 'hikvision',
              confidence: 'high',
              model: 'DS-TEST',
              via: 'isapi_deviceInfo'
            }
          };
        },
        probeBiostarServer: async () => {
          calls.push('bio');
          return { vendor: 'biostar', ok: false, reason: 'no_match', ms: 1 };
        },
        probeZktecoTcp: async () => {
          calls.push('zk');
          return { vendor: 'zkteco', ok: false, reason: 'no_match', ms: 1, bestEffort: true };
        }
      }
    );
    assert.deepEqual(calls, ['hik']);
    assert.equal(result.candidates[0].brandId, 'hikvision');
    assert.equal(result.status, 'completed');
  });

  it('ZK basura / puerto cerrado no lanza', async () => {
    const auto = require(path.join(__dirname, '../../scripts/lib/hardwareAutoDetect.js'));
    const res = await auto.probeZktecoTcp({ host: '127.0.0.1', port: 1 });
    assert.equal(res.vendor, 'zkteco');
    assert.equal(res.ok, false);
    assert.equal(res.bestEffort, true);
  });
});
