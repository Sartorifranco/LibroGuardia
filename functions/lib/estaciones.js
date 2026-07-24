/**
 * Estaciones de hardware: agrupan varios lectores físicos en un mismo proceso
 * door-reader-bridge (mini PC / Raspberry Pi) + servidor HTTP local.
 * Colección Firestore `estaciones`.
 */

const crypto = require('crypto');
const { db, FieldValue } = require('../firestore');
const {
  buildDoorReaderConfig,
  listLectores,
  DEFAULT_API_BASE_URL
} = require('./lectores');

const ESTACIONES = 'estaciones';

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const generateStationSecret = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

const toEstacionJson = (doc) => {
  const data = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || data.id;
  return {
    id,
    nombre: data.nombre || '',
    direccionRedLocal: data.direccionRedLocal || '',
    puertoServidorLocal: Number(data.puertoServidorLocal) || 8787,
    secretoLocal: data.secretoLocal || '',
    activa: data.activa !== false,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null
  };
};

const sanitizeEstacionFields = (body = {}, previous = {}) => {
  const nombre = String(body.nombre != null ? body.nombre : previous.nombre || '').trim();
  if (!nombre) throw httpError(400, 'El nombre de la estación es obligatorio');

  const direccionRedLocal = String(
    body.direccionRedLocal != null ? body.direccionRedLocal : previous.direccionRedLocal || ''
  ).trim();

  let puertoServidorLocal = Number(
    body.puertoServidorLocal != null ? body.puertoServidorLocal : previous.puertoServidorLocal
  );
  if (!Number.isFinite(puertoServidorLocal) || puertoServidorLocal < 1 || puertoServidorLocal > 65535) {
    puertoServidorLocal = 8787;
  }
  puertoServidorLocal = Math.floor(puertoServidorLocal);

  let secretoLocal = String(
    body.secretoLocal != null ? body.secretoLocal : previous.secretoLocal || ''
  ).trim();
  if (!secretoLocal) {
    secretoLocal = previous.secretoLocal || generateStationSecret();
  }

  const activa = body.activa !== undefined
    ? body.activa !== false && body.activa !== 'false' && body.activa !== 0
    : (previous.activa !== false);

  return {
    nombre,
    direccionRedLocal,
    puertoServidorLocal,
    secretoLocal,
    activa
  };
};

const listEstaciones = async () => {
  const snap = await db.collection(ESTACIONES).orderBy('nombre').get();
  return snap.docs.map(toEstacionJson);
};

const getEstacionById = async (id) => {
  const snap = await db.collection(ESTACIONES).doc(id).get();
  if (!snap.exists) throw httpError(404, 'Estación no encontrada');
  return toEstacionJson(snap);
};

const createEstacion = async (body = {}) => {
  const fields = sanitizeEstacionFields(body);
  const ref = db.collection(ESTACIONES).doc();
  const doc = {
    ...fields,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  await ref.set(doc);
  return toEstacionJson({ id: ref.id, data: () => doc });
};

const updateEstacion = async (id, body = {}) => {
  const ref = db.collection(ESTACIONES).doc(id);
  const beforeSnap = await ref.get();
  if (!beforeSnap.exists) throw httpError(404, 'Estación no encontrada');
  const before = beforeSnap.data() || {};
  const fields = sanitizeEstacionFields({ ...before, ...body }, before);
  await ref.set({
    ...fields,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const afterSnap = await ref.get();
  return {
    before: toEstacionJson(beforeSnap),
    estacion: toEstacionJson(afterSnap)
  };
};

/**
 * Borra la estación y desasocia lectores (estacionId → '').
 */
const deleteEstacion = async (id) => {
  const ref = db.collection(ESTACIONES).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Estación no encontrada');
  const before = toEstacionJson(snap);

  const lectoresSnap = await db.collection('lectores')
    .where('estacionId', '==', id)
    .get();
  await Promise.all(lectoresSnap.docs.map(async (doc) => {
    await doc.ref.set({
      estacionId: '',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }));

  await ref.delete();
  return before;
};

const listLectoresDeEstacion = async (estacionId) => {
  const id = String(estacionId || '').trim();
  if (!id) return [];
  const all = await listLectores();
  return all
    .filter((l) => String(l.estacionId || '') === id)
    .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
};

/**
 * Asigna (o quita) lectores a una estación.
 * @param {string} estacionId
 * @param {string[]} lectorIds — lista completa deseada (los no listados se desasocian)
 */
const setLectoresDeEstacion = async (estacionId, lectorIds = []) => {
  await getEstacionById(estacionId);
  const wanted = new Set(
    (Array.isArray(lectorIds) ? lectorIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );

  const all = await listLectores();
  const updates = [];

  for (const lector of all) {
    const current = String(lector.estacionId || '');
    const shouldBelong = wanted.has(lector.id);
    if (shouldBelong && current !== estacionId) {
      updates.push(
        db.collection('lectores').doc(lector.id).set({
          estacionId,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true })
      );
    } else if (!shouldBelong && current === estacionId) {
      updates.push(
        db.collection('lectores').doc(lector.id).set({
          estacionId: '',
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true })
      );
    }
  }

  // Validar que los IDs pedidos existan
  for (const id of wanted) {
    if (!all.some((l) => l.id === id)) {
      throw httpError(400, `Lector inexistente: ${id}`, 'unknown_lector');
    }
  }

  await Promise.all(updates);
  return listLectoresDeEstacion(estacionId);
};

/**
 * Entrada de un lector dentro del JSON de estación (formato readers[]).
 */
const buildReaderEntryForStation = (lector, { apiBaseUrl, password = '' } = {}) => {
  const flat = buildDoorReaderConfig({
    apiBaseUrl,
    username: lector.usuarioSistemaId,
    password,
    doorId: lector.doorId,
    readerId: lector.readerId,
    lectorId: lector.id,
    offlineCache: lector.offlineCache,
    localFirstMode: lector.localFirstMode,
    offlineCacheRefreshMs: lector.offlineCacheRefreshMs,
    offlineCacheMaxAgeHours: lector.offlineCacheMaxAgeHours,
    serialPort: lector.puertoDetectado || 'COM3'
  });
  return {
    username: flat.username,
    password: flat.password,
    doorId: flat.doorId,
    readerId: flat.readerId,
    lectorId: flat.lectorId,
    serialPort: flat.serialPort,
    baudRate: flat.baudRate,
    idleMs: flat.idleMs,
    inputMode: flat.inputMode,
    offlineCache: flat.offlineCache,
    localFirstMode: flat.localFirstMode,
    offlineCacheRefreshMs: flat.offlineCacheRefreshMs,
    offlineCacheMaxAgeHours: flat.offlineCacheMaxAgeHours
  };
};

/**
 * Campos del servidor HTTP local del bridge a partir de una estación.
 * null si no aplica (inactiva / sin secreto).
 */
const localServerFieldsFromEstacion = (estacion) => {
  if (!estacion) return null;
  if (estacion.activa === false) return null;
  const secretoLocal = String(estacion.secretoLocal || '').trim();
  if (!secretoLocal) return null;
  const puerto = Number(estacion.puertoServidorLocal);
  return {
    localServerPort: Number.isFinite(puerto) && puerto > 0 ? Math.floor(puerto) : 8787,
    localServerSecret: secretoLocal,
    localServerHost: '0.0.0.0',
    _meta: {
      estacionId: estacion.id,
      estacionNombre: estacion.nombre || '',
      direccionRedLocal: estacion.direccionRedLocal || ''
    }
  };
};

/**
 * Si el lector tiene estacionId, mezcla localServer* en el JSON del bridge.
 * Estación inexistente / inactiva / sin secreto → deja el config igual (retrocompat).
 */
const enrichConfigWithEstacion = async (config = {}, estacionId = '') => {
  const id = String(estacionId || '').trim();
  if (!id || !config || typeof config !== 'object') return config;
  try {
    const estacion = await getEstacionById(id);
    const fields = localServerFieldsFromEstacion(estacion);
    if (!fields) return config;
    return { ...config, ...fields };
  } catch (err) {
    if (err.status === 404) return config;
    throw err;
  }
};

/**
 * JSON unificado para door-reader-bridge (formato estación con readers[]).
 * Sin passwords de kiosk salvo que se pasen en passwordsByLectorId.
 * Incluye localServerPort/Secret de la estación.
 */
const buildStationConfigForDownload = async (
  estacionId,
  { apiBaseUrl, passwordsByLectorId = {} } = {}
) => {
  const estacion = await getEstacionById(estacionId);
  const lectores = await listLectoresDeEstacion(estacionId);
  const base = String(apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const localFields = localServerFieldsFromEstacion(estacion) || {
    localServerPort: estacion.puertoServidorLocal,
    localServerSecret: estacion.secretoLocal,
    localServerHost: '0.0.0.0',
    _meta: {
      estacionId: estacion.id,
      estacionNombre: estacion.nombre,
      direccionRedLocal: estacion.direccionRedLocal
    }
  };

  return {
    apiBaseUrl: base,
    localServerPort: localFields.localServerPort,
    localServerSecret: localFields.localServerSecret,
    localServerHost: localFields.localServerHost,
    readers: lectores.map((l) => buildReaderEntryForStation(l, {
      apiBaseUrl: base,
      password: passwordsByLectorId[l.id] || ''
    })),
    logFile: '/var/log/door-reader-bridge.log',
    reconnectMinMs: 2000,
    reconnectMaxMs: 60000,
    _meta: localFields._meta
  };
};

module.exports = {
  ESTACIONES,
  generateStationSecret,
  toEstacionJson,
  sanitizeEstacionFields,
  listEstaciones,
  getEstacionById,
  createEstacion,
  updateEstacion,
  deleteEstacion,
  listLectoresDeEstacion,
  setLectoresDeEstacion,
  buildReaderEntryForStation,
  localServerFieldsFromEstacion,
  enrichConfigWithEstacion,
  buildStationConfigForDownload
};
