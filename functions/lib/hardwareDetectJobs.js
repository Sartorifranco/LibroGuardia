/**
 * Cola de auto-detección de marca de hardware (Admin → estación LAN).
 * El password del equipo vive en el doc solo hasta el claim; luego se redacta.
 *
 * Limpieza de jobs vencidos: SOLO vía TTL nativo de Firestore sobre `expireAt`
 * (Firebase Console → Firestore → TTL → colección hardware_detect_jobs).
 * No hay cron/onSchedule de limpieza — regla de costo cero.
 */

const { db, FieldValue, Timestamp } = require('../firestore');
const { getEstacionById } = require('./estaciones');

const COLLECTION = 'hardware_detect_jobs';
const JOB_TTL_MS = 25_000;
/** Estación “en línea” si hubo heartbeat en esta ventana. */
const STATION_ONLINE_MS = 5 * 60 * 1000;
const PASSWORD_REDACTED = null;

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const toMillis = (value) => {
  if (value == null) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  if (Number.isFinite(n) && n > 1e11) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const isEstacionOnline = (estacion) => {
  const ms = toMillis(estacion?.ultimaConexion);
  if (ms == null) return false;
  return Date.now() - ms <= STATION_ONLINE_MS;
};

const publicJobView = (id, data = {}) => {
  const status = String(data.status || 'pending');
  const expiresAtMs = toMillis(data.expiresAt) || toMillis(data.expireAt);
  const expired = expiresAtMs != null && Date.now() > expiresAtMs
    && (status === 'pending' || status === 'running');
  return {
    jobId: id,
    status: expired ? 'expired' : status,
    estacionId: data.estacionId || '',
    host: data.host || '',
    port: data.port == null ? null : data.port,
    httpsPreferred: Boolean(data.httpsPreferred),
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
    probes: Array.isArray(data.probes) ? data.probes : [],
    error: data.error || null,
    expiresAt: data.expiresAtIso || (expiresAtMs ? new Date(expiresAtMs).toISOString() : null),
    createdAt: data.createdAtIso || null,
    claimedAt: data.claimedAtIso || null,
    completedAt: data.completedAtIso || null
    // password NUNCA en vistas admin
  };
};

/**
 * Crea un job de detección. Persiste password solo hasta el claim.
 */
const createHardwareDetectJob = async ({
  estacionId,
  host,
  port = null,
  username = '',
  password = '',
  httpsPreferred = false,
  requestedBy = null
} = {}) => {
  const estId = String(estacionId || '').trim();
  const ip = String(host || '').trim();
  if (!estId) throw httpError(400, 'estacionId es obligatorio');
  if (!ip) throw httpError(400, 'host (IP del equipo) es obligatorio');

  const estacion = await getEstacionById(estId);
  if (estacion.activa === false) {
    throw httpError(409, 'La estación está inactiva. Activála o elegí otra.', 'station_inactive');
  }
  if (!isEstacionOnline(estacion)) {
    throw httpError(
      409,
      'La estación no está en línea (sin heartbeat reciente). No se puede detectar desde la nube; verificá que el programa de estación esté corriendo en planta.',
      'station_offline'
    );
  }

  const now = Date.now();
  const expiresAtMs = now + JOB_TTL_MS;
  const ref = db.collection(COLLECTION).doc();
  const payload = {
    estacionId: estId,
    host: ip.slice(0, 200),
    port: port == null || port === '' ? null : Math.max(1, Math.min(65535, Number(port) || 0)) || null,
    username: String(username || '').slice(0, 120),
    password: String(password || ''),
    httpsPreferred: Boolean(httpsPreferred),
    status: 'pending',
    candidates: [],
    probes: [],
    error: null,
    requestedBy: requestedBy || null,
    createdAtMs: now,
    createdAtIso: new Date(now).toISOString(),
    expiresAtIso: new Date(expiresAtMs).toISOString(),
    // Timestamp para TTL nativo de Firestore (activar en consola, sin función programada).
    expireAt: Timestamp.fromMillis(expiresAtMs),
    expiresAt: Timestamp.fromMillis(expiresAtMs),
    createdAt: FieldValue.serverTimestamp()
  };
  await ref.set(payload);

  return {
    jobId: ref.id,
    status: 'pending',
    expiresAt: payload.expiresAtIso,
    collection: COLLECTION
  };
};

/**
 * Claim atómico para la estación: pending → running y redacta password en el doc.
 * Devuelve el password en claro SOLO en el objeto de retorno (response HTTP), nunca en logs.
 */
const claimHardwareDetectJobs = async (username, { limit = 3 } = {}) => {
  const { resolveEstacionForAgentUser } = require('./estaciones');
  const estacion = await resolveEstacionForAgentUser(username);
  const max = Math.max(1, Math.min(5, Number(limit) || 3));

  const snap = await db.collection(COLLECTION)
    .where('estacionId', '==', estacion.id)
    .where('status', '==', 'pending')
    .limit(20)
    .get();

  const now = Date.now();
  const jobs = [];
  for (const doc of snap.docs) {
    if (jobs.length >= max) break;
    const data = doc.data() || {};
    const exp = toMillis(data.expiresAt) || toMillis(data.expireAt);
    if (exp != null && now > exp) {
      await doc.ref.set({
        status: 'expired',
        password: PASSWORD_REDACTED,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      continue;
    }

    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (!fresh.exists) return null;
      const cur = fresh.data() || {};
      if (cur.status !== 'pending') return null;
      const passwordPlain = String(cur.password || '');
      const claimedAtIso = new Date().toISOString();
      tx.set(doc.ref, {
        status: 'running',
        password: PASSWORD_REDACTED,
        passwordRedactedAt: FieldValue.serverTimestamp(),
        claimedAtIso,
        claimedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return {
        jobId: fresh.id,
        host: cur.host || '',
        port: cur.port == null ? null : cur.port,
        username: cur.username || '',
        password: passwordPlain,
        httpsPreferred: Boolean(cur.httpsPreferred),
        expiresAt: cur.expiresAtIso || null
      };
    });

    if (claimed) jobs.push(claimed);
  }

  return { estacionId: estacion.id, jobs };
};

const reportHardwareDetectResult = async (username, body = {}) => {
  const { resolveEstacionForAgentUser } = require('./estaciones');
  const estacion = await resolveEstacionForAgentUser(username);
  const jobId = String(body.jobId || '').trim();
  if (!jobId) throw httpError(400, 'jobId requerido');

  const ref = db.collection(COLLECTION).doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Job no encontrado');
  const data = snap.data() || {};
  if (String(data.estacionId || '') !== estacion.id) {
    throw httpError(403, 'Este job no pertenece a esta estación');
  }

  let status = String(body.status || 'completed').trim();
  if (!['completed', 'failed', 'unknown'].includes(status)) status = 'completed';
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 10) : [];
  const probes = Array.isArray(body.probes) ? body.probes.slice(0, 20) : [];
  if (!candidates.length && status === 'completed') status = 'unknown';

  const completedAtIso = new Date().toISOString();
  await ref.set({
    status,
    candidates,
    probes,
    error: body.error ? String(body.error).slice(0, 500) : null,
    password: PASSWORD_REDACTED,
    completedAtIso,
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return publicJobView(jobId, { ...data, status, candidates, probes, completedAtIso });
};

const getHardwareDetectJob = async (jobId) => {
  const id = String(jobId || '').trim();
  if (!id) throw httpError(400, 'jobId requerido');
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) throw httpError(404, 'Job no encontrado');
  return publicJobView(id, snap.data() || {});
};

/**
 * Helper de test / mantenimiento manual: borra docs con expireAt vencido.
 * En producción la limpieza la hace el TTL nativo de Firestore (consola),
 * no un onSchedule — no exportar esto como Cloud Function.
 */
const cleanupExpiredHardwareDetectJobs = async ({ limit = 100 } = {}) => {
  const now = Timestamp.now();
  const snap = await db.collection(COLLECTION)
    .where('expireAt', '<=', now)
    .limit(Math.max(1, Math.min(500, Number(limit) || 100)))
    .get();

  let deleted = 0;
  const batchSize = 40;
  let batch = db.batch();
  let ops = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    ops += 1;
    deleted += 1;
    if (ops >= batchSize) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { deleted, scanned: snap.size };
};

module.exports = {
  COLLECTION,
  JOB_TTL_MS,
  createHardwareDetectJob,
  claimHardwareDetectJobs,
  reportHardwareDetectResult,
  getHardwareDetectJob,
  cleanupExpiredHardwareDetectJobs,
  publicJobView,
  isEstacionOnline
};
