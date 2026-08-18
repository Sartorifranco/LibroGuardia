const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const signatures = require(path.join(__dirname, '../../scripts/lib/hardwareDetectSignatures'));

describe('hardwareDetectSignatures', () => {
  it('parsea ISAPI XML → hikvision high', () => {
    const xml = `<?xml version="1.0"?>
<DeviceInfo version="2.0">
  <deviceName>Access Control</deviceName>
  <model>DS-K1T671M</model>
  <serialNumber>DS-123</serialNumber>
  <firmwareVersion>V4.5.0</firmwareVersion>
  <manufacturer>Hikvision</manufacturer>
</DeviceInfo>`;
    const c = signatures.parseIsapiDeviceInfo(xml, 'application/xml');
    assert.equal(c.brandId, 'hikvision');
    assert.equal(c.confidence, 'high');
    assert.equal(c.model, 'DS-K1T671M');
  });

  it('parsea login BioStar con bs-session-id', () => {
    const c = signatures.parseBiostarLoginSuccess({
      headers: { 'bs-session-id': 'abc-session' },
      bodyText: '{"Response":{"code":"0"}}'
    });
    assert.equal(c.brandId, 'suprema');
    assert.equal(c.via, 'biostar2_server');
    assert.equal(c.confidence, 'high');
  });

  it('fingerprint ZK TCP válido / basura', () => {
    const pkt = Buffer.alloc(8);
    pkt.writeUInt16LE(2000, 0); // ACK_OK
    pkt.writeUInt16LE(0, 2);
    pkt.writeUInt16LE(1, 4);
    pkt.writeUInt16LE(0, 6);
    const ok = signatures.parseZktecoTcpFingerprint(pkt);
    assert.equal(ok.brandId, 'zkteco');
    assert.equal(ok.bestEffort, true);

    const junk = Buffer.from('HTTP/1.1 200 OK\r\n');
    assert.equal(signatures.parseZktecoTcpFingerprint(junk), null);
  });

  it('HTML genérico no es candidato ISAPI', () => {
    assert.equal(signatures.isGenericHttpNoise('<!DOCTYPE html><html></html>', 'text/html'), true);
    assert.equal(
      signatures.parseIsapiDeviceInfo('<html>hello</html>', 'text/html'),
      null
    );
  });
});
