/**
 * Meta de allowlist por puerta. Evita reconstruir (cientos de lecturas) cuando
 * el bridge ya tiene la misma versión y no cambió el padrón ni el día AR.
 */
const { db, FieldValue } = require('../firestore');
const { buildDoorAllowlist } = require('./doorAllowlist');
const { readDataVersions } = require('./dataVersions');

const COLLECTION = 'allowlist_cache';

/** Día civil Argentina (citaciones / validUntil dependen del día). */
const dateBucketAR = (now = new Date()) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

const metaRef = (doorId) => db.collection(COLLECTION).doc(String(doorId || '').trim());

const readAllowlistMeta = async (doorId) => {
  const id = String(doorId || '').trim();
  if (!id) return null;
  const snap = await metaRef(id).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    version: Number(data.version) || 0,
    dateBucket: String(data.dateBucket || ''),
    count: Number(data.count) || 0,
    generatedAt: data.generatedAt || null,
    peopleVer: Number(data.peopleVer) || 0,
    authorizationsVer: Number(data.authorizationsVer) || 0,
    doorsVer: Number(data.doorsVer) || 0
  };
};

const writeAllowlistMeta = async (doorId, meta, dataVer) => {
  const id = String(doorId || '').trim();
  if (!id) return;
  await metaRef(id).set({
    version: Number(meta.version) || 1,
    dateBucket: String(meta.dateBucket || ''),
    count: Number(meta.count) || 0,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    peopleVer: Number(dataVer.people) || 0,
    authorizationsVer: Number(dataVer.authorizations) || 0,
    doorsVer: Number(dataVer.doors) || 0,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
};

const inputsMatch = (meta, dataVer) => (
  meta
  && Number(meta.peopleVer) === Number(dataVer.people)
  && Number(meta.authorizationsVer) === Number(dataVer.authorizations)
  && Number(meta.doorsVer) === Number(dataVer.doors)
);

/**
 * Resuelve allowlist con skip barato cuando el cliente ya tiene la versión vigente.
 * @returns {Promise<object>} allowlist completa o { unchanged: true, version, dateBucket, count }
 */
const resolveDoorAllowlist = async (doorId, options = {}) => {
  const id = String(doorId || '').trim();
  if (!id) {
    const err = new Error('doorId requerido');
    err.status = 400;
    throw err;
  }

  const force = options.force === true
    || options.force === '1'
    || options.force === 1;
  const clientVersion = options.clientVersion != null && options.clientVersion !== ''
    ? Number(options.clientVersion)
    : null;
  const today = dateBucketAR();

  const [meta, dataVer] = await Promise.all([
    readAllowlistMeta(id),
    readDataVersions()
  ]);

  const fresh = meta
    && meta.dateBucket === today
    && inputsMatch(meta, dataVer);

  if (!force && fresh && clientVersion != null && Number.isFinite(clientVersion)
    && clientVersion === meta.version) {
    return {
      unchanged: true,
      doorId: id,
      version: meta.version,
      dateBucket: today,
      count: meta.count,
      generatedAt: meta.generatedAt
    };
  }

  const allowlist = await buildDoorAllowlist(id, options);
  // Misma versión si el padrón y el día no cambiaron (cliente sin cache / force soft).
  const nextVersion = (!fresh || force)
    ? (Number(meta?.version) || 0) + 1
    : (Number(meta.version) || 1);

  await writeAllowlistMeta(id, {
    version: nextVersion,
    dateBucket: today,
    count: allowlist.count,
    generatedAt: allowlist.generatedAt
  }, dataVer);

  return {
    ...allowlist,
    unchanged: false,
    version: nextVersion,
    dateBucket: today
  };
};

module.exports = {
  COLLECTION,
  dateBucketAR,
  readAllowlistMeta,
  resolveDoorAllowlist
};
