/**
 * Códigos de emparejamiento de 6 dígitos para instalar un lector
 * sin copiar password/JSON a mano.
 *
 * Colección Firestore `lectorPairingCodes`:
 *   doc id = código (6 dígitos)
 *   { lectorId, expiresAt (ms), usedAt (ms|null), createdAt }
 */

const { db, FieldValue } = require('../firestore');
const crypto = require('crypto');
const {
  getLectorById,
  regenerateCredentials,
  DEFAULT_API_BASE_URL
} = require('./lectores');

const PAIRING_COLLECTION = 'lectorPairingCodes';
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_RE = /^\d{6}$/;
/** Mensaje genérico: no filtrar existencia / expiración / usado. */
const INVALID_CODE_MESSAGE = 'Código inválido o expirado';

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const generateSixDigitCode = () => {
  // 100000–999999 (siempre 6 dígitos)
  return String(Math.floor(100000 + Math.random() * 900000));
};

/**
 * Invalida códigos activos previos del mismo lector (solo queda el nuevo).
 */
const invalidateActiveCodesForLector = async (lectorId) => {
  const snap = await db.collection(PAIRING_COLLECTION)
    .where('lectorId', '==', lectorId)
    .get();
  const now = Date.now();
  await Promise.all(snap.docs.map(async (doc) => {
    const data = doc.data() || {};
    if (data.usedAt) return;
    const expiresAt = Number(data.expiresAt) || 0;
    if (expiresAt && expiresAt < now) return;
    await doc.ref.set({
      usedAt: now,
      invalidatedAt: now,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }));
};

/**
 * Genera un código de un solo uso (10 min) para el lector.
 * @returns {{ code: string, expiresAt: string, expiresInSeconds: number, lectorId: string }}
 */
const createPairingCode = async (lectorId) => {
  const lector = await getLectorById(lectorId);
  if (!lector.usuarioSistemaId) {
    throw httpError(400, 'El lector no tiene usuario de sistema asociado');
  }

  await invalidateActiveCodesForLector(lectorId);

  let code = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generateSixDigitCode();
    const ref = db.collection(PAIRING_COLLECTION).doc(candidate);
    const existing = await ref.get();
    if (existing.exists) {
      const data = existing.data() || {};
      const expiresAt = Number(data.expiresAt) || 0;
      // Reusar slot si el código viejo ya no sirve
      if (!data.usedAt && expiresAt > Date.now()) continue;
    }
    code = candidate;
    const expiresAtMs = Date.now() + PAIRING_TTL_MS;
    await ref.set({
      lectorId,
      expiresAt: expiresAtMs,
      usedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    break;
  }

  if (!code) {
    throw httpError(500, 'No se pudo generar un código de emparejamiento único');
  }

  return {
    code,
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    expiresInSeconds: Math.floor(PAIRING_TTL_MS / 1000),
    lectorId,
    lectorNombre: lector.nombre || '',
    doorId: lector.doorId,
    readerId: lector.readerId
  };
};

/**
 * Canjea el código: regenera password + devuelve config completa.
 * Errores de código siempre genéricos (anti-enumeración).
 */
const exchangePairingCode = async (rawCode, { apiBaseUrl } = {}) => {
  const code = String(rawCode || '').trim();
  if (!PAIRING_CODE_RE.test(code)) {
    throw httpError(400, INVALID_CODE_MESSAGE, 'invalid_pairing_code');
  }

  const ref = db.collection(PAIRING_COLLECTION).doc(code);
  const snap = await ref.get();
  if (!snap.exists) {
    throw httpError(400, INVALID_CODE_MESSAGE, 'invalid_pairing_code');
  }

  const data = snap.data() || {};
  const now = Date.now();
  if (data.usedAt) {
    throw httpError(400, INVALID_CODE_MESSAGE, 'invalid_pairing_code');
  }
  const expiresAt = Number(data.expiresAt) || 0;
  if (!expiresAt || expiresAt < now) {
    throw httpError(400, INVALID_CODE_MESSAGE, 'invalid_pairing_code');
  }

  const lectorId = String(data.lectorId || '').trim();
  if (!lectorId) {
    throw httpError(400, INVALID_CODE_MESSAGE, 'invalid_pairing_code');
  }

  // Un solo uso: claim atómico sin transacción (claimId gana).
  const claimId = crypto.randomBytes(8).toString('hex');
  await ref.set({
    usedAt: now,
    claimId,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  const afterMark = await ref.get();
  const afterData = afterMark.data() || {};
  if (afterData.claimId !== claimId) {
    throw httpError(400, INVALID_CODE_MESSAGE, 'invalid_pairing_code');
  }

  const base = apiBaseUrl || DEFAULT_API_BASE_URL;
  const result = await regenerateCredentials(lectorId, { apiBaseUrl: base });

  return {
    message: 'Emparejamiento OK. Guardá el JSON: la contraseña no se volverá a mostrar.',
    lector: result.lector,
    password: result.password,
    config: result.config
  };
};

module.exports = {
  PAIRING_COLLECTION,
  PAIRING_TTL_MS,
  INVALID_CODE_MESSAGE,
  PAIRING_CODE_RE,
  generateSixDigitCode,
  createPairingCode,
  exchangePairingCode,
  invalidateActiveCodesForLector
};
