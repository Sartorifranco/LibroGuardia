/**
 * Versión del listado admin de Personas.
 * El frontend manda clientVersion; si coincide, no se relee la colección.
 */
const { db, FieldValue } = require('../firestore');
const { readDataVersions } = require('./dataVersions');

const SETTINGS_DOC = 'peopleListCache';

const readPeopleListMeta = async () => {
  const [snap, dataVer] = await Promise.all([
    db.collection('settings').doc(SETTINGS_DOC).get(),
    readDataVersions()
  ]);
  const data = snap.exists ? (snap.data() || {}) : {};
  return {
    version: Number(data.version) || 0,
    peopleVer: Number(data.peopleVer) || 0,
    count: Number(data.count) || 0,
    currentPeopleVer: dataVer.people
  };
};

const writePeopleListMeta = async ({ version, count, peopleVer }) => {
  await db.collection('settings').doc(SETTINGS_DOC).set({
    version: Number(version) || 1,
    count: Number(count) || 0,
    peopleVer: Number(peopleVer) || 0,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
};

/**
 * @returns {{ unchanged: true, version } | { unchanged: false, version, needsRebuild: true }}
 */
const resolvePeopleListVersion = async (clientVersion) => {
  const meta = await readPeopleListMeta();
  const fresh = meta.peopleVer === meta.currentPeopleVer && meta.version > 0;
  const client = clientVersion != null && clientVersion !== ''
    ? Number(clientVersion)
    : null;

  if (fresh && client != null && Number.isFinite(client) && client === meta.version) {
    return { unchanged: true, version: meta.version, count: meta.count };
  }

  const nextVersion = fresh
    ? (meta.version || 1)
    : (meta.version || 0) + 1;

  return {
    unchanged: false,
    version: nextVersion,
    peopleVer: meta.currentPeopleVer,
    needsRebuild: true
  };
};

module.exports = {
  SETTINGS_DOC,
  readPeopleListMeta,
  writePeopleListMeta,
  resolvePeopleListVersion
};
