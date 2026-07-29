/**
 * Puerta de entrada unificada de acceso (Fase A).
 * Normaliza payloads de distintos hardwares hacia processKioskScan.
 * El endpoint legado /access/kiosk-scan sigue funcionando vía este helper.
 */

const AUTH_METHOD_ALIASES = {
  dni: 'dni',
  document: 'dni',
  credential: 'credential',
  card: 'credential',
  rfid: 'credential',
  tarjeta: 'credential',
  biometric: 'biometric',
  biometrics: 'biometric',
  face: 'biometric',
  fingerprint: 'biometric',
  huella: 'biometric',
  rostro: 'biometric',
  manual: 'manual'
};

const normalizeAuthMethod = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return AUTH_METHOD_ALIASES[key] || null;
};

/**
 * Arma rawData compatible con detectAuthMethod / processKioskScan.
 * - dni: payload crudo del PDF417 o DNI
 * - credential: prefijo CARD# para forzar tarjeta
 * - biometric: prefijo BIO# + id externo del equipo
 */
const buildRawDataFromIngest = ({
  authMethod = null,
  rawData = '',
  identity = {},
  credentialCode = '',
  biometricExternalId = '',
  idNumber = ''
} = {}) => {
  const trimmedRaw = String(rawData || '').trim();
  if (trimmedRaw) return trimmedRaw;

  const method = normalizeAuthMethod(authMethod)
    || (biometricExternalId || identity.biometricExternalId ? 'biometric' : null)
    || (credentialCode || identity.cardCode || identity.credentialCode ? 'credential' : null)
    || (idNumber || identity.dni || identity.idNumber ? 'dni' : null);

  if (method === 'biometric') {
    const id = String(
      biometricExternalId
      || identity.biometricExternalId
      || identity.externalId
      || ''
    ).trim();
    return id ? `BIO#${id}` : '';
  }

  if (method === 'credential') {
    const code = String(
      credentialCode
      || identity.cardCode
      || identity.credentialCode
      || identity.externalId
      || ''
    ).trim();
    return code ? `CARD#${code}` : '';
  }

  if (method === 'dni') {
    return String(idNumber || identity.dni || identity.idNumber || '').trim();
  }

  return '';
};

/**
 * @returns {{ ok: true, args: object } | { ok: false, status: number, message: string }}
 */
const normalizeAccessIngestRequest = (body = {}, username = '') => {
  const doorId = body.doorId || body.device?.doorId || null;
  const readerId = String(
    body.readerId
    || body.deviceId
    || body.device?.readerId
    || body.device?.id
    || 'default'
  ).trim() || 'default';

  const rawData = buildRawDataFromIngest({
    authMethod: body.authMethod || body.method || body.device?.authMethod,
    rawData: body.rawData || body.payload || body.scanData,
    identity: body.identity || {},
    credentialCode: body.credentialCode || body.cardCode,
    biometricExternalId: body.biometricExternalId || body.externalId,
    idNumber: body.idNumber || body.dni
  });

  if (!String(rawData || '').trim()) {
    return {
      ok: false,
      status: 400,
      message: 'Faltan datos de identificación (rawData, tarjeta, DNI o ID biométrico)'
    };
  }

  return {
    ok: true,
    args: {
      rawData,
      username,
      doorId,
      readerId,
      // Metadatos opcionales para logs futuros (processKioskScan los ignora hoy).
      ingestMeta: {
        vendor: body.vendor || body.brand || body.device?.vendor || null,
        authMethod: normalizeAuthMethod(body.authMethod || body.method) || null,
        deviceId: body.deviceId || body.device?.id || null
      }
    }
  };
};

module.exports = {
  AUTH_METHOD_ALIASES,
  normalizeAuthMethod,
  buildRawDataFromIngest,
  normalizeAccessIngestRequest
};
