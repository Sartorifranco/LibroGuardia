/**
 * Sync de estación: solo con credenciales propias de estación (estacionId /
 * stationUsername). La config legacy de un lector no debe loguearse cada 45 s
 * con el usuario del lector (404 / bloqueos en la nube).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const bridgePath = path.join(__dirname, '..', '..', 'scripts', 'programa-estacion.js');
const { normalizeStationConfig } = require(bridgePath);

const env = { API_BASE_URL: '', DOOR_READER_CONFIG: '' };
const legacy = {
  apiBaseUrl: 'https://mss-guard.web.app/api',
  username: 'kiosk.p1.l1',
  password: 'x'.repeat(24),
  doorId: 'puerta-p1',
  readerId: 'INGRESO_P1',
  serialPort: 'COM3'
};

describe('normalizeStationConfig: stationSyncEnabled', () => {
  it('legacy de un lector (username es del lector) → sin sync de estación', () => {
    const station = normalizeStationConfig(legacy, env, 'C:\\cfg\\door-reader.config.json');
    assert.equal(station.stationSyncEnabled, false);
    assert.equal(station.stationUsername, 'kiosk.p1.l1');
  });

  it('legacy con stationUsername explícito → sync con esas credenciales', () => {
    const station = normalizeStationConfig({
      ...legacy,
      stationUsername: 'kiosk.estacion1',
      stationPassword: 'y'.repeat(24)
    }, env, 'C:\\cfg\\door-reader.config.json');
    assert.equal(station.stationSyncEnabled, true);
    assert.equal(station.stationUsername, 'kiosk.estacion1');
  });

  it('legacy con estacionId → sync habilitado', () => {
    const station = normalizeStationConfig({ ...legacy, estacionId: 'est-1' }, env, 'C:\\cfg\\c.json');
    assert.equal(station.stationSyncEnabled, true);
  });

  it('formato estación (readers[] + username raíz) → sync habilitado', () => {
    const station = normalizeStationConfig({
      apiBaseUrl: 'https://mss-guard.web.app/api',
      username: 'kiosk.estacion1',
      password: 'z'.repeat(24),
      readers: [{ ...legacy }]
    }, env, 'C:\\cfg\\configuracion-estacion.json');
    assert.equal(station.stationSyncEnabled, true);
    assert.equal(station.stationUsername, 'kiosk.estacion1');
  });

  it('config descargada de Admin (readers[] + _meta.estacionId) → sync habilitado', () => {
    const station = normalizeStationConfig({
      apiBaseUrl: 'https://mss-guard.web.app/api',
      readers: [{ ...legacy }],
      _meta: { estacionId: 'est-1', estacionNombre: 'Portón' }
    }, env, 'C:\\cfg\\configuracion-estacion.json');
    assert.equal(station.stationSyncEnabled, true);
    assert.equal(station.stationUsername, 'kiosk.p1.l1', 'reusa la cuenta del lector (mismo token)');
  });

  it('formato readers[] sin credenciales de estación ni estacionId → sin sync', () => {
    const station = normalizeStationConfig({
      apiBaseUrl: 'https://mss-guard.web.app/api',
      readers: [{ ...legacy }]
    }, env, 'C:\\cfg\\configuracion-estacion.json');
    assert.equal(station.stationSyncEnabled, false);
  });
});
