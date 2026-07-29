const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  resolvePluginId,
  parseReaderFrame,
  toIngestBody,
  getReaderPlugin
} = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'stationReaderPlugins'));

describe('stationReaderPlugins', () => {
  it('default es serial_dni (compat DNI)', () => {
    assert.equal(resolvePluginId(''), 'serial_dni');
    assert.equal(getReaderPlugin('dni_generic').id, 'serial_dni');
    const parsed = parseReaderFrame('serial_dni', '30111222');
    assert.equal(parsed.authMethod, 'dni');
    assert.equal(parsed.rawData, '30111222');
  });

  it('zkteco interpreta ID corto como biométrico', () => {
    const parsed = parseReaderFrame('zkteco', 'EMP-42');
    assert.equal(parsed.authMethod, 'biometric');
    assert.equal(parsed.biometricExternalId, 'EMP-42');
    assert.equal(parsed.rawData, 'BIO#EMP-42');
    assert.equal(parsed.vendor, 'zkteco');
  });

  it('hid interpreta número como tarjeta', () => {
    const parsed = parseReaderFrame('hid', 'A1B2C3');
    assert.equal(parsed.authMethod, 'credential');
    assert.equal(parsed.credentialCode, 'A1B2C3');
    assert.equal(parsed.rawData, 'CARD#A1B2C3');
  });

  it('prefijos universales CARD# / BIO#', () => {
    const card = parseReaderFrame('zkteco', 'CARD#9988');
    assert.equal(card.authMethod, 'credential');
    const bio = parseReaderFrame('hid', 'BIO:77');
    assert.equal(bio.authMethod, 'biometric');
    assert.equal(bio.biometricExternalId, '77');
  });

  it('toIngestBody arma el contrato de /access/ingest', () => {
    const body = toIngestBody(parseReaderFrame('hikvision', 'User=55'), {
      doorId: 'puerta-p1',
      readerId: 'INGRESO_P1'
    });
    assert.equal(body.doorId, 'puerta-p1');
    assert.equal(body.readerId, 'INGRESO_P1');
    assert.equal(body.authMethod, 'biometric');
    assert.equal(body.biometricExternalId, '55');
    assert.equal(body.vendor, 'hikvision');
  });
});
