/**
 * Identidad de equipos del edge (Etapa 2, docs/ETAPA2-DISENO.md §4 "Identidad de equipos").
 *
 * Reemplaza a los usuarios kiosk_puerta / lectores / estaciones:
 *   Admin crea equipo → código de enrolamiento de un uso (10 min, guardado hasheado)
 *   → `mss-edge enroll <código>` genera par Ed25519 y canjea el código
 *   → deviceId + refresh token (la nube guarda solo sha256)
 *   → POST /token firmado con la clave del equipo rota el refresh y devuelve un JWT de 1 h
 *     (claims {sub, kind:'device', siteId, deviceKind}) y, para el hub, un custom token Firebase.
 *
 * Colecciones:
 *   devices/{deviceId}            { siteId, kind, name, doorIds, status active|pending|revoked|replaced,
 *                                   pubKey (PEM SPKI), refreshHash, prevRefreshHash, ... }
 *   deviceEnrollCodes/{sha256}    { deviceId, siteId, expiresAt (ms), usedAt (ms|null) }
 */

const crypto = require('crypto');
const { db, admin, FieldValue } = require('../firestore');
const { signAuthToken } = require('../middleware/auth');

const DEVICES_COLLECTION = 'devices';
const ENROLL_CODES_COLLECTION = 'deviceEnrollCodes';
const ENROLL_TTL_MS = 10 * 60 * 1000;
const ENROLL_CODE_LENGTH = 8;
/** Sin 0/O/1/I/L: se dicta y se tipea en la planta. */
const ENROLL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ENROLL_CODE_RE = /^[A-Z0-9]{6,8}$/;
const DEVICE_KINDS = ['hub', 'controller'];
const DEVICE_TOKEN_TTL = '1h';
const DEVICE_TOKEN_TTL_SECONDS = 3600;
/** Ventana de la firma del pedido de token (reloj del equipo vs nube). */
const TOKEN_SIGNATURE_WINDOW_MS = 60 * 1000;
/**
 * Gracia de rotación del refresh token: si el equipo perdió la respuesta de /token (corte de red
 * justo después de rotar), puede presentar UNA vez el refresh inmediatamente anterior dentro de
 * esta ventana, siempre que el más nuevo nunca se haya usado. Pasada la ventana (o usada la gracia)
 * → REFRESH_REUSED como siempre.
 */
const REFRESH_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_SITE_ID = 'principal';
const INVALID_CODE_MESSAGE = 'Código inválido o expirado';
const INVALID_DEVICE_CREDENTIALS = 'Credenciales de equipo inválidas';

/** Prefijo DER SPKI de una clave pública Ed25519 (RFC 8410): 12 bytes + 32 de clave. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const normalizeEnrollCode = (code) => String(code || '').trim().toUpperCase().replace(/[\s-]+/g, '');

const generateEnrollCode = (length = ENROLL_CODE_LENGTH) => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ENROLL_ALPHABET[crypto.randomInt(ENROLL_ALPHABET.length)];
  return out;
};

const generateDeviceId = (kind) => `${kind === 'hub' ? 'hub' : 'ctl'}_${crypto.randomBytes(8).toString('hex')}`;
const generateRefreshToken = () => crypto.randomBytes(32).toString('base64url');

const sanitizeSiteId = (value) => {
  const id = String(value || DEFAULT_SITE_ID).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw httpError(400, 'siteId inválido');
  return id;
};

const sanitizeDoorIds = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'doorIds debe ser una lista');
  return [...new Set(value.map((d) => String(d || '').trim()).filter(Boolean))].slice(0, 32);
};

/**
 * Acepta PEM SPKI o la clave cruda de 32 bytes en base64/base64url (o el DER SPKI en base64).
 * @returns {crypto.KeyObject}
 */
const parseEd25519PublicKey = (input) => {
  const raw = String(input || '').trim();
  if (!raw) throw httpError(400, 'Falta publicKey');
  let key;
  try {
    if (raw.includes('BEGIN PUBLIC KEY')) {
      key = crypto.createPublicKey(raw);
    } else {
      const buf = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const der = buf.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, buf]) : buf;
      key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
  } catch (_err) {
    throw httpError(400, 'publicKey inválida (se espera Ed25519 PEM o base64 de 32 bytes)');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw httpError(400, 'publicKey debe ser Ed25519');
  return key;
};

const publicKeyToPem = (key) => key.export({ type: 'spki', format: 'pem' }).toString();

/** Id corto de la clave (para logs / Admin). */
const publicKeyId = (pem) => sha256(pem).slice(0, 16);

/**
 * Mensaje firmado del pedido de token. Formato vigente (el que usa el hub,
 * scripts/edge/hub/cloudClient.js): "mss-edge-token\n<deviceId>\n<ts>" (con prefijo de dominio,
 * no se puede confundir con otra firma del equipo). Se acepta además el formato original
 * "<deviceId>.<ts>" (legado, primeros prototipos) — TODO: quitar cuando no queden equipos que lo usen.
 */
const tokenSigningMessages = (deviceId, ts) => [`mss-edge-token\n${deviceId}\n${ts}`, `${deviceId}.${ts}`];

const verifyDeviceSignature = (pem, message, signatureB64) => {
  try {
    const key = crypto.createPublicKey(pem);
    const sig = Buffer.from(String(signatureB64 || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message), key, sig);
  } catch (_err) {
    return false;
  }
};

const toMillis = (value) => {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
};

const deviceToJSON = (id, data = {}) => ({
  id,
  siteId: data.siteId || DEFAULT_SITE_ID,
  kind: data.kind,
  name: data.name || '',
  doorIds: Array.isArray(data.doorIds) ? data.doorIds : [],
  status: data.status || 'pending',
  hostname: data.hostname || null,
  keyId: data.keyId || null,
  replacesDeviceId: data.replacesDeviceId || null,
  replacedBy: data.replacedBy || null,
  lastSeenAt: toMillis(data.lastSeenAt),
  configVersionApplied: data.configVersionApplied ?? null,
  checks: data.checks || null,
  lanUrl: data.lanUrl || null,
  online: data.online ?? null,
  statusUpdatedAt: toMillis(data.statusUpdatedAt),
  reportedBy: data.reportedBy || null
});

/** Crea un código nuevo para el equipo (doc id = sha256 del código). */
const issueEnrollCode = async ({ deviceId, siteId }, now = Date.now()) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateEnrollCode();
    const ref = db.collection(ENROLL_CODES_COLLECTION).doc(sha256(code));
    // eslint-disable-next-line no-await-in-loop
    const existing = await ref.get();
    if (existing.exists) {
      const data = existing.data() || {};
      if (!data.usedAt && Number(data.expiresAt) > now) continue;
    }
    const expiresAt = now + ENROLL_TTL_MS;
    // eslint-disable-next-line no-await-in-loop
    await ref.set({ deviceId, siteId, expiresAt, usedAt: null, createdAt: FieldValue.serverTimestamp() });
    return { code, expiresAt: new Date(expiresAt).toISOString(), expiresInSeconds: ENROLL_TTL_MS / 1000 };
  }
  throw httpError(503, 'No se pudo generar un código de enrolamiento; reintentar');
};

/**
 * Alta de equipo (Admin). Devuelve el device y el código de un uso (en claro, una sola vez).
 */
const createDevice = async ({ siteId, kind, name, doorIds } = {}, { createdBy = null } = {}) => {
  const k = String(kind || '').trim();
  if (!DEVICE_KINDS.includes(k)) throw httpError(400, "kind debe ser 'hub' o 'controller'");
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw httpError(400, 'Falta el nombre del equipo');
  const site = sanitizeSiteId(siteId);
  const doors = sanitizeDoorIds(doorIds);
  const deviceId = generateDeviceId(k);
  const data = {
    siteId: site,
    kind: k,
    name: n,
    doorIds: doors,
    status: 'pending',
    pubKey: null,
    keyId: null,
    refreshHash: null,
    prevRefreshHash: null,
    createdBy,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  await db.collection(DEVICES_COLLECTION).doc(deviceId).set(data);
  const enroll = await issueEnrollCode({ deviceId, siteId: site });
  return { device: deviceToJSON(deviceId, data), enrollment: enroll };
};

const getDeviceDoc = async (deviceId) => {
  const id = String(deviceId || '').trim();
  if (!id || id.includes('/')) throw httpError(404, 'Equipo no encontrado');
  const snap = await db.collection(DEVICES_COLLECTION).doc(id).get();
  if (!snap.exists) throw httpError(404, 'Equipo no encontrado');
  return { id, ref: snap.ref, data: snap.data() || {} };
};

const listDevices = async ({ siteId } = {}) => {
  let q = db.collection(DEVICES_COLLECTION);
  if (siteId) q = q.where('siteId', '==', sanitizeSiteId(siteId));
  const snap = await q.limit(500).get();
  return snap.docs.map((d) => deviceToJSON(d.id, d.data()));
};

const revokeDevice = async (deviceId, { by = null, reason = null } = {}) => {
  const { id, ref, data } = await getDeviceDoc(deviceId);
  const update = {
    status: 'revoked',
    refreshHash: null,
    prevRefreshHash: null,
    revokedAt: Date.now(),
    revokedBy: by,
    revokeReason: reason ? String(reason).slice(0, 300) : null,
    updatedAt: FieldValue.serverTimestamp()
  };
  await ref.set(update, { merge: true });
  return { before: deviceToJSON(id, data), after: deviceToJSON(id, { ...data, ...update }) };
};

/**
 * "Reemplazar equipo": alta de uno nuevo que hereda sitio, tipo y puertas; el viejo
 * queda `replaced` (sin refresh: no puede pedir más tokens).
 */
const replaceDevice = async (deviceId, { by = null, name = null } = {}) => {
  const { id, ref, data } = await getDeviceDoc(deviceId);
  if (data.status === 'replaced') throw httpError(409, 'El equipo ya fue reemplazado', 'DEVICE_ALREADY_REPLACED');
  const created = await createDevice({
    siteId: data.siteId,
    kind: data.kind,
    name: name || data.name,
    doorIds: data.doorIds || []
  }, { createdBy: by });
  await db.collection(DEVICES_COLLECTION).doc(created.device.id).set({ replacesDeviceId: id }, { merge: true });
  const update = {
    status: 'replaced',
    replacedBy: created.device.id,
    refreshHash: null,
    prevRefreshHash: null,
    replacedAt: Date.now(),
    updatedAt: FieldValue.serverTimestamp()
  };
  await ref.set(update, { merge: true });
  return {
    old: deviceToJSON(id, { ...data, ...update }),
    device: { ...created.device, replacesDeviceId: id },
    enrollment: created.enrollment
  };
};

/**
 * Canje del código: registra la clave pública y entrega deviceId + refresh token.
 * Errores de código → siempre el mismo mensaje (no filtrar existencia/expiración/uso).
 */
const enrollDevice = async ({ code, publicKey, kind, hostname } = {}, now = Date.now()) => {
  const normalized = normalizeEnrollCode(code);
  if (!ENROLL_CODE_RE.test(normalized)) throw httpError(400, INVALID_CODE_MESSAGE, 'INVALID_CODE');
  const key = parseEd25519PublicKey(publicKey);
  const pem = publicKeyToPem(key);
  const refreshToken = generateRefreshToken();
  const codeRef = db.collection(ENROLL_CODES_COLLECTION).doc(sha256(normalized));

  const result = await db.runTransaction(async (tx) => {
    const codeSnap = await tx.get(codeRef);
    const c = codeSnap.exists ? codeSnap.data() || {} : null;
    if (!c || c.usedAt || !(Number(c.expiresAt) > now)) {
      throw httpError(400, INVALID_CODE_MESSAGE, 'INVALID_CODE');
    }
    const devRef = db.collection(DEVICES_COLLECTION).doc(String(c.deviceId));
    const devSnap = await tx.get(devRef);
    const d = devSnap.exists ? devSnap.data() || {} : null;
    if (!d || d.status !== 'pending') throw httpError(400, INVALID_CODE_MESSAGE, 'INVALID_CODE');
    if (kind && String(kind) !== d.kind) {
      throw httpError(400, `El código es para un equipo de tipo '${d.kind}'`, 'KIND_MISMATCH');
    }
    tx.set(codeRef, { usedAt: now }, { merge: true });
    tx.set(devRef, {
      status: 'active',
      pubKey: pem,
      keyId: publicKeyId(pem),
      hostname: hostname ? String(hostname).slice(0, 120) : null,
      refreshHash: sha256(refreshToken),
      prevRefreshHash: null,
      enrolledAt: now,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { deviceId: devRef.id, siteId: d.siteId || DEFAULT_SITE_ID, kind: d.kind };
  });
  return { ...result, refreshToken };
};

const signDeviceToken = ({ deviceId, siteId, deviceKind }) => signAuthToken(
  { sub: deviceId, kind: 'device', siteId, deviceKind },
  { expiresIn: DEVICE_TOKEN_TTL }
);

/** Custom token Firebase (solo hub): el listener de `compiled/head` y `commands`. */
const createFirebaseCustomToken = async ({ deviceId, siteId, kind }) => (
  admin.auth().createCustomToken(deviceId, { siteId, deviceId, kind })
);

/**
 * Pedido de token: firma Ed25519 (ver `tokenSigningMessages`) + refresh vigente.
 * Rota el refresh: el viejo queda como `prevRefreshHash` (+ `refreshRotatedAt`) para detectar
 * reuso y para la gracia de `REFRESH_GRACE_MS` (respuesta de rotación perdida).
 */
const exchangeDeviceToken = async ({ deviceId, ts, signature, refreshToken } = {}, now = Date.now()) => {
  const id = String(deviceId || '').trim();
  const t = Number(ts);
  if (!id || id.includes('/') || !Number.isFinite(t) || !signature || !refreshToken) {
    throw httpError(400, 'Faltan deviceId, ts, signature o refreshToken');
  }
  if (Math.abs(now - t) > TOKEN_SIGNATURE_WINDOW_MS) {
    throw httpError(401, 'Firma fuera de la ventana de tiempo (revisar reloj del equipo)', 'CLOCK_SKEW');
  }
  const devRef = db.collection(DEVICES_COLLECTION).doc(id);
  const presentedHash = sha256(refreshToken);
  const nextRefresh = generateRefreshToken();

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(devRef);
    const d = snap.exists ? snap.data() || {} : null;
    if (!d || !d.pubKey) return { error: httpError(401, INVALID_DEVICE_CREDENTIALS, 'INVALID_DEVICE') };
    if (d.status !== 'active') {
      return { error: httpError(401, 'Equipo revocado o reemplazado', 'DEVICE_REVOKED') };
    }
    if (!tokenSigningMessages(id, t).some((msg) => verifyDeviceSignature(d.pubKey, msg, signature))) {
      return { error: httpError(401, INVALID_DEVICE_CREDENTIALS, 'BAD_SIGNATURE') };
    }
    let grace = false;
    if (d.refreshHash !== presentedHash) {
      if (d.prevRefreshHash && d.prevRefreshHash === presentedHash) {
        // El más nuevo nunca se usó (si se hubiera usado, prevRefreshHash sería el suyo).
        const rotatedAt = toMillis(d.refreshRotatedAt);
        const inGrace = rotatedAt != null && now - rotatedAt <= REFRESH_GRACE_MS && !d.refreshGraceUsed;
        if (!inGrace) {
          tx.set(devRef, { refreshReuseAt: now, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          return { error: httpError(401, 'Refresh token ya usado', 'REFRESH_REUSED') };
        }
        grace = true;
      } else {
        return { error: httpError(401, INVALID_DEVICE_CREDENTIALS, 'BAD_REFRESH') };
      }
    }
    tx.set(devRef, grace ? {
      // Gracia: se vuelve a rotar; el anterior sigue como prev pero ya no tiene otra gracia.
      refreshHash: sha256(nextRefresh),
      refreshGraceUsed: true,
      refreshGraceAt: now,
      lastTokenAt: now,
      updatedAt: FieldValue.serverTimestamp()
    } : {
      refreshHash: sha256(nextRefresh),
      prevRefreshHash: presentedHash,
      refreshRotatedAt: now,
      refreshGraceUsed: false,
      lastTokenAt: now,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { device: { id, siteId: d.siteId || DEFAULT_SITE_ID, kind: d.kind } };
  });
  if (outcome.error) throw outcome.error;

  const { device } = outcome;
  const token = signDeviceToken({ deviceId: device.id, siteId: device.siteId, deviceKind: device.kind });
  const out = {
    token,
    expiresIn: DEVICE_TOKEN_TTL_SECONDS,
    refreshToken: nextRefresh,
    deviceId: device.id,
    siteId: device.siteId,
    kind: device.kind
  };
  if (device.kind === 'hub') {
    out.firebaseToken = await createFirebaseCustomToken({ deviceId: device.id, siteId: device.siteId, kind: device.kind });
  }
  return out;
};

module.exports = {
  DEVICES_COLLECTION,
  ENROLL_CODES_COLLECTION,
  ENROLL_TTL_MS,
  ENROLL_CODE_LENGTH,
  DEVICE_KINDS,
  DEVICE_TOKEN_TTL_SECONDS,
  TOKEN_SIGNATURE_WINDOW_MS,
  REFRESH_GRACE_MS,
  DEFAULT_SITE_ID,
  INVALID_CODE_MESSAGE,
  httpError,
  sha256,
  normalizeEnrollCode,
  generateEnrollCode,
  sanitizeSiteId,
  parseEd25519PublicKey,
  publicKeyToPem,
  publicKeyId,
  verifyDeviceSignature,
  tokenSigningMessages,
  deviceToJSON,
  toMillis,
  createDevice,
  getDeviceDoc,
  listDevices,
  revokeDevice,
  replaceDevice,
  enrollDevice,
  exchangeDeviceToken,
  signDeviceToken
};
