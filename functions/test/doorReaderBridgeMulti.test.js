const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const bridgePath = path.join(__dirname, '..', '..', 'scripts', 'door-reader-bridge.js');
const { normalizeStationConfig } = require(bridgePath);

describe('door-reader-bridge multi-lector config', () => {
  const baseEnv = {
    API_BASE_URL: '',
    DOOR_READER_CONFIG: ''
  };

  it('formato legacy (plano) → un solo lector en readers[]', () => {
    const station = normalizeStationConfig({
      apiBaseUrl: 'https://bacarguard.web.app/api',
      username: 'kiosk.p1',
      password: 'secret',
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1',
      serialPort: 'COM3',
      offlineCache: true,
      localFirstMode: true
    }, baseEnv, 'C:\\cfg\\door-reader.config.json');

    assert.equal(station.readers.length, 1);
    assert.equal(station.readers[0].doorId, 'puerta-p1');
    assert.equal(station.readers[0].readerId, 'INGRESO_P1');
    assert.equal(station.readers[0].serialPort, 'COM3');
    assert.equal(station.readers[0].username, 'kiosk.p1');
    assert.equal(station.readers[0].offlineCache, true);
    assert.equal(station.readers[0].localFirstMode, true);
    assert.match(station.readers[0].offlineAllowlistFile, /door-allowlist-puerta-p1\.json$/);
  });

  it('formato nuevo con readers[] mantiene cada lector independiente', () => {
    const station = normalizeStationConfig({
      apiBaseUrl: 'https://bacarguard.web.app/api',
      readers: [
        {
          doorId: 'puerta-p1',
          readerId: 'INGRESO_P1',
          serialPort: 'COM3',
          username: 'kiosk.a',
          password: 'a',
          offlineCache: true,
          localFirstMode: true
        },
        {
          doorId: 'puerta-p2',
          readerId: 'INGRESO_P2',
          serialPort: 'COM4',
          username: 'kiosk.b',
          password: 'b',
          offlineCache: false
        }
      ]
    }, baseEnv, 'C:\\cfg\\station.config.json');

    assert.equal(station.readers.length, 2);
    assert.equal(station.readers[0].serialPort, 'COM3');
    assert.equal(station.readers[1].serialPort, 'COM4');
    assert.equal(station.readers[0].localFirstMode, true);
    assert.equal(station.readers[1].localFirstMode, false);
    assert.notEqual(
      station.readers[0].offlineAllowlistFile,
      station.readers[1].offlineAllowlistFile
    );
    assert.notEqual(
      station.readers[0].offlineQueueFile,
      station.readers[1].offlineQueueFile
    );
  });

  it('rechaza readers sin credenciales o doorId', () => {
    assert.throws(
      () => normalizeStationConfig({
        apiBaseUrl: 'https://bacarguard.web.app/api',
        readers: [{ doorId: 'p1', readerId: 'r1', username: '', password: '' }]
      }, baseEnv, 'x.json'),
      /username\/password/
    );
  });
});
