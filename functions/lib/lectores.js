/**
 * Lectores físicos (mini PC + GADNIC + door-reader-bridge).
 * Colección Firestore `lectores` + helpers de config/credenciales.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, FieldValue } = require('../firestore');
const { getDoorsConfig, findDoorById } = require('./doorsConfig');
const { getRoleById, createRole } = require('../roles');
const { PERMISSION_KEYS } = require('../permissions');

const LECTORES = 'lectores';
const KIOSK_ROLE_ID = 'kiosk_puerta';
const DIRECTIONS = ['ingreso', 'egreso', 'ambos'];

/** Heartbeat del bridge ~5 min → umbrales de estado en UI. */
const STATUS_GREEN_MS = 10 * 60 * 1000; // ≤10 min: vivo (2 heartbeats de margen)
const STATUS_YELLOW_MS = 30 * 60 * 1000; // ≤30 min: stale; >30 o nunca → offline

const DEFAULT_API_BASE_URL = 'https://bacarguard.web.app/api';

const slugify = (value = '') => String(value)
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '.')
  .replace(/^\.+|\.+$/g, '')
  .slice(0, 40);

const generatePassword = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const toLectorJson = (doc) => {
  const data = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || data.id;
  return {
    id,
    nombre: data.nombre || '',
    doorId: data.doorId || '',
    readerId: data.readerId || '',
    direction: data.direction || 'ambos',
    usuarioSistemaId: data.usuarioSistemaId || '',
    ultimaConexion: data.ultimaConexion || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null
  };
};

/**
 * Estado de conexión para UI.
 * @returns {'online'|'stale'|'offline'}
 */
const resolveConnectionStatus = (ultimaConexion, nowMs = Date.now()) => {
  if (!ultimaConexion) return 'offline';
  let ts = ultimaConexion;
  if (typeof ultimaConexion.toMillis === 'function') ts = ultimaConexion.toMillis();
  else if (ultimaConexion._seconds != null) ts = ultimaConexion._seconds * 1000;
  else if (ultimaConexion.seconds != null) ts = ultimaConexion.seconds * 1000;
  else ts = Number(ultimaConexion);
  if (!Number.isFinite(ts)) return 'offline';
  const age = nowMs - ts;
  if (age <= STATUS_GREEN_MS) return 'online';
  if (age <= STATUS_YELLOW_MS) return 'stale';
  return 'offline';
};

const validateDoorAndReader = async ({ doorId, readerId, direction }) => {
  const doorsConfig = await getDoorsConfig();
  const door = findDoorById(doorsConfig, doorId);
  if (!door) {
    throw httpError(400, `Puerta inexistente: ${doorId}`, 'unknown_door');
  }
  const readers = Array.isArray(door.readers) ? door.readers : [];
  const reader = readers.find((r) => r && r.id === readerId);
  if (!reader && !(Array.isArray(door.readerIds) && door.readerIds.includes(readerId))) {
    throw httpError(
      400,
      `El lector “${readerId}” no está definido en la puerta “${doorId}”. Configuralo en Admin → Puertas.`,
      'unknown_reader'
    );
  }
  const dir = DIRECTIONS.includes(direction) ? direction : 'ambos';
  return { door, direction: dir, doorsConfig };
};

const sanitizeLectorFields = (body = {}) => {
  const nombre = String(body.nombre || '').trim();
  if (!nombre) throw httpError(400, 'El nombre es obligatorio');
  const doorId = String(body.doorId || '').trim();
  if (!doorId) throw httpError(400, 'doorId es obligatorio');
  const readerId = String(body.readerId || '').trim();
  if (!readerId) throw httpError(400, 'readerId es obligatorio');
  const direction = DIRECTIONS.includes(body.direction) ? body.direction : null;
  if (!direction) throw httpError(400, 'direction debe ser ingreso, egreso o ambos');
  return { nombre, doorId, readerId, direction };
};

const buildDoorReaderConfig = ({
  apiBaseUrl,
  username,
  password,
  doorId,
  readerId,
  lectorId = ''
}) => ({
  apiBaseUrl: String(apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, ''),
  username: String(username || ''),
  password: password == null ? '' : String(password),
  doorId: String(doorId || ''),
  readerId: String(readerId || ''),
  lectorId: String(lectorId || ''),
  serialPort: 'COM3',
  baudRate: 9600,
  idleMs: 120,
  inputMode: 'serial',
  logFile: '/var/log/door-reader-bridge.log',
  reconnectMinMs: 2000,
  reconnectMaxMs: 60000
});

const ensureKioskRole = async () => {
  const existing = await getRoleById(KIOSK_ROLE_ID);
  if (existing) return existing;
  return createRole({
    id: KIOSK_ROLE_ID,
    label: 'Kiosk puerta',
    description: 'Solo escaneo headless por lector físico (door-reader-bridge).',
    permissions: ['access.kiosk'].filter((p) => PERMISSION_KEYS.includes(p)),
    dashboardProfile: 'operational'
  });
};

const allocateUsername = async (nombre, doorId, readerId) => {
  const base = `kiosk.${slugify(doorId) || 'puerta'}.${slugify(readerId) || slugify(nombre) || 'lector'}`
    .replace(/\.+/g, '.')
    .slice(0, 56);
  let candidate = base;
  for (let i = 0; i < 8; i += 1) {
    const snap = await db.collection('users').doc(candidate).get();
    if (!snap.exists) return candidate;
    candidate = `${base}.${crypto.randomBytes(2).toString('hex')}`;
  }
  throw httpError(500, 'No se pudo asignar un username único para el kiosk');
};

const createSystemUser = async (username, password) => {
  await ensureKioskRole();
  const passwordHash = await bcrypt.hash(password, 10);
  const userRef = db.collection('users').doc(username);
  await userRef.set({
    username,
    password: passwordHash,
    role: KIOSK_ROLE_ID,
    active: true,
    mustChangePassword: false,
    passwordVersion: 1,
    permissions: ['access.kiosk'],
    createdAt: FieldValue.serverTimestamp()
  });
  return username;
};

const setUserPassword = async (username, password) => {
  const userRef = db.collection('users').doc(username);
  const snap = await userRef.get();
  if (!snap.exists) throw httpError(404, 'Usuario de sistema del lector no encontrado');
  const passwordHash = await bcrypt.hash(password, 10);
  const prev = snap.data() || {};
  await userRef.update({
    password: passwordHash,
    passwordVersion: (Number(prev.passwordVersion) || 1) + 1,
    mustChangePassword: false,
    active: true
  });
};

const deleteSystemUser = async (username) => {
  if (!username) return;
  const userRef = db.collection('users').doc(username);
  const snap = await userRef.get();
  if (snap.exists) await userRef.delete();
};

const resolveApiBaseUrl = (req) => {
  const fromEnv = String(process.env.PUBLIC_API_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (host && /bacarguard|web\.app|localhost/i.test(String(host))) {
    return `${proto}://${host}/api`.replace(/([^:]\/)\/+/g, '$1');
  }
  return DEFAULT_API_BASE_URL;
};

const listLectores = async () => {
  const snap = await db.collection(LECTORES).orderBy('nombre').get();
  return snap.docs.map(toLectorJson);
};

const getLectorById = async (id) => {
  const snap = await db.collection(LECTORES).doc(id).get();
  if (!snap.exists) throw httpError(404, 'Lector no encontrado');
  return toLectorJson(snap);
};

const createLector = async (body, { apiBaseUrl } = {}) => {
  const fields = sanitizeLectorFields(body);
  await validateDoorAndReader(fields);

  const password = generatePassword();
  const username = await allocateUsername(fields.nombre, fields.doorId, fields.readerId);
  await createSystemUser(username, password);

  const ref = db.collection(LECTORES).doc();
  const doc = {
    ...fields,
    usuarioSistemaId: username,
    ultimaConexion: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  await ref.set(doc);

  const lector = toLectorJson({ id: ref.id, data: () => doc });
  const config = buildDoorReaderConfig({
    apiBaseUrl: apiBaseUrl || DEFAULT_API_BASE_URL,
    username,
    password,
    doorId: fields.doorId,
    readerId: fields.readerId,
    lectorId: ref.id
  });

  return { lector, password, config, username };
};

const updateLector = async (id, body) => {
  const ref = db.collection(LECTORES).doc(id);
  const beforeSnap = await ref.get();
  if (!beforeSnap.exists) throw httpError(404, 'Lector no encontrado');
  const before = beforeSnap.data();
  const fields = sanitizeLectorFields({ ...before, ...body });
  await validateDoorAndReader(fields);
  await ref.set({
    ...fields,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const afterSnap = await ref.get();
  return {
    before: toLectorJson(beforeSnap),
    lector: toLectorJson(afterSnap)
  };
};

const deleteLector = async (id) => {
  const ref = db.collection(LECTORES).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Lector no encontrado');
  const before = toLectorJson(snap);
  await ref.delete();
  await deleteSystemUser(before.usuarioSistemaId);
  return before;
};

const regenerateCredentials = async (id, { apiBaseUrl } = {}) => {
  const lector = await getLectorById(id);
  if (!lector.usuarioSistemaId) {
    throw httpError(400, 'El lector no tiene usuario de sistema asociado');
  }
  const password = generatePassword();
  await setUserPassword(lector.usuarioSistemaId, password);
  await db.collection(LECTORES).doc(id).set({
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  const config = buildDoorReaderConfig({
    apiBaseUrl: apiBaseUrl || DEFAULT_API_BASE_URL,
    username: lector.usuarioSistemaId,
    password,
    doorId: lector.doorId,
    readerId: lector.readerId,
    lectorId: id
  });

  return { lector, password, config };
};

const buildConfigForDownload = async (id, { apiBaseUrl, includePassword = false, password = '' } = {}) => {
  const lector = await getLectorById(id);
  return buildDoorReaderConfig({
    apiBaseUrl: apiBaseUrl || DEFAULT_API_BASE_URL,
    username: lector.usuarioSistemaId,
    password: includePassword ? password : '',
    doorId: lector.doorId,
    readerId: lector.readerId,
    lectorId: id
  });
};

/**
 * Heartbeat del bridge: actualiza ultimaConexion del lector del usuario kiosk.
 */
const touchHeartbeat = async ({ username, lectorId = null, doorId = null, readerId = null }) => {
  const uid = String(username || '').trim().toLowerCase();
  if (!uid) throw httpError(401, 'No autenticado');

  let ref = null;
  if (lectorId) {
    const snap = await db.collection(LECTORES).doc(lectorId).get();
    if (!snap.exists) throw httpError(404, 'Lector no encontrado');
    const data = snap.data() || {};
    if (String(data.usuarioSistemaId || '').toLowerCase() !== uid) {
      throw httpError(403, 'Este lector no pertenece al usuario autenticado');
    }
    ref = snap.ref || db.collection(LECTORES).doc(lectorId);
  } else {
    let query = db.collection(LECTORES).where('usuarioSistemaId', '==', uid).limit(1);
    const snap = await query.get();
    if (snap.empty && doorId && readerId) {
      const byDoor = await db.collection(LECTORES)
        .where('doorId', '==', doorId)
        .where('readerId', '==', readerId)
        .limit(5)
        .get();
      const match = byDoor.docs.find((d) => String(d.data().usuarioSistemaId || '').toLowerCase() === uid);
      if (match) {
        ref = match.ref;
      }
    } else if (!snap.empty) {
      ref = snap.docs[0].ref;
    }
  }

  if (!ref) {
    throw httpError(
      404,
      'No hay un lector registrado para este usuario. Crealo en Admin → Lectores.',
      'lector_not_linked'
    );
  }

  await ref.set({
    ultimaConexion: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  const after = await ref.get();
  return toLectorJson(after);
};

module.exports = {
  LECTORES,
  KIOSK_ROLE_ID,
  DIRECTIONS,
  STATUS_GREEN_MS,
  STATUS_YELLOW_MS,
  DEFAULT_API_BASE_URL,
  slugify,
  generatePassword,
  toLectorJson,
  resolveConnectionStatus,
  sanitizeLectorFields,
  buildDoorReaderConfig,
  ensureKioskRole,
  resolveApiBaseUrl,
  listLectores,
  getLectorById,
  createLector,
  updateLector,
  deleteLector,
  regenerateCredentials,
  buildConfigForDownload,
  touchHeartbeat,
  validateDoorAndReader
};
