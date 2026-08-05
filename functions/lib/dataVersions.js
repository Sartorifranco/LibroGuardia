/**
 * Contadores baratos para saber si hay que regenerar allowlist / listados.
 * Un solo documento settings/dataVersions: leerlo cuesta 1 lectura.
 */
const { db, FieldValue } = require('../firestore');

const SETTINGS_DOC = 'dataVersions';

const emptyVersions = () => ({
  people: 0,
  authorizations: 0,
  doors: 0
});

const readDataVersions = async () => {
  const snap = await db.collection('settings').doc(SETTINGS_DOC).get();
  if (!snap.exists) return emptyVersions();
  const data = snap.data() || {};
  return {
    people: Number(data.people) || 0,
    authorizations: Number(data.authorizations) || 0,
    doors: Number(data.doors) || 0
  };
};

const bumpDataVersion = async (field) => {
  const key = String(field || '').trim();
  if (!['people', 'authorizations', 'doors'].includes(key)) return;
  await db.collection('settings').doc(SETTINGS_DOC).set({
    [key]: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
};

const bumpPeopleVersion = () => bumpDataVersion('people');
const bumpAuthorizationsVersion = () => bumpDataVersion('authorizations');
const bumpDoorsVersion = () => bumpDataVersion('doors');

module.exports = {
  SETTINGS_DOC,
  readDataVersions,
  bumpDataVersion,
  bumpPeopleVersion,
  bumpAuthorizationsVersion,
  bumpDoorsVersion
};
