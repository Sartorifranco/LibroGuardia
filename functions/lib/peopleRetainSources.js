/**
 * Conservar en `people` solo fichas de nómina o BioStar.
 * El resto se desactiva (no se borra) para no romper historial de accesos.
 */

const { db, FieldValue, admin } = require('../firestore');

const FieldPath = admin.firestore.FieldPath;

const hasBiostarSignal = (data = {}) => {
  if (String(data.biometricExternalId || '').trim()) return true;
  if (String(data.biostarUserId || '').trim()) return true;
  const source = String(data.source || '').toLowerCase();
  if (source === 'biostar' || source === 'biostar_link') return true;
  if (String(data.biometricBrand || '').toLowerCase() === 'suprema') return true;
  return false;
};

const hasNominaSignal = (data = {}, personId, nominaPersonIds) => {
  const origen = String(data.origen || '').toLowerCase();
  const source = String(data.source || '').toLowerCase();
  if (origen === 'nomina' || source === 'nomina') return true;
  if (personId && nominaPersonIds instanceof Set && nominaPersonIds.has(personId)) return true;
  return false;
};

/** Keep = nómina o BioStar. */
const shouldKeepPerson = (data = {}, personId = '', nominaPersonIds = new Set()) => (
  hasBiostarSignal(data) || hasNominaSignal(data, personId, nominaPersonIds)
);

const loadNominaPersonIds = async () => {
  const snap = await db.collection('personalMaster')
    .where('source', '==', 'nomina')
    .get();
  const ids = new Set();
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (data.active === false) return;
    const personId = String(data.personId || '').trim();
    if (personId) ids.add(personId);
  });
  return ids;
};

const classifyPerson = (doc, nominaPersonIds) => {
  const data = doc.data() || {};
  const id = doc.id;
  const name = String(data.name || data.nombre || id).trim() || id;
  if (data.mergedIntoId || data.active === false) {
    return { kind: 'already_out', id, name };
  }
  if (shouldKeepPerson(data, id, nominaPersonIds)) {
    const reason = hasBiostarSignal(data) ? 'biostar' : 'nomina';
    return { kind: 'keep', id, name, reason };
  }
  return { kind: 'deactivate', id, name };
};

/**
 * Plan dry-run: recorre toda la colección people.
 */
const buildRetainSourcesPlan = async () => {
  const nominaPersonIds = await loadNominaPersonIds();
  const summary = {
    keep: 0,
    keepNomina: 0,
    keepBiostar: 0,
    deactivate: 0,
    alreadyOut: 0,
    scanned: 0,
    nominaMasterLinked: nominaPersonIds.size
  };
  const sampleDeactivate = [];
  const sampleKeep = [];

  let lastId = null;
  for (;;) {
    let query = db.collection('people').orderBy(FieldPath.documentId()).limit(300);
    if (lastId) query = query.startAfter(lastId);
    const snap = await query.get();
    if (snap.empty) break;

    snap.docs.forEach((doc) => {
      lastId = doc.id;
      summary.scanned += 1;
      const row = classifyPerson(doc, nominaPersonIds);
      if (row.kind === 'keep') {
        summary.keep += 1;
        if (row.reason === 'biostar') summary.keepBiostar += 1;
        else summary.keepNomina += 1;
        if (sampleKeep.length < 8) sampleKeep.push({ id: row.id, name: row.name, reason: row.reason });
      } else if (row.kind === 'deactivate') {
        summary.deactivate += 1;
        if (sampleDeactivate.length < 25) {
          sampleDeactivate.push({ id: row.id, name: row.name });
        }
      } else {
        summary.alreadyOut += 1;
      }
    });

    if (snap.size < 300) break;
  }

  return {
    summary,
    sampleDeactivate,
    sampleKeep,
    policy: 'keep_nomina_or_biostar'
  };
};

/**
 * Desactiva un lote de no-keepers. Pagina con cursor (doc id).
 */
const applyRetainSourcesStep = async ({ cursor = null, batchSize = 40 } = {}) => {
  const nominaPersonIds = await loadNominaPersonIds();
  const size = Math.max(1, Math.min(80, Number(batchSize) || 40));

  let deactivated = 0;
  let keep = 0;
  let alreadyOut = 0;
  let scanned = 0;
  let lastId = cursor || null;
  let exhausted = false;
  const sample = [];

  while (deactivated < size && !exhausted) {
    let query = db.collection('people').orderBy(FieldPath.documentId()).limit(100);
    if (lastId) query = query.startAfter(lastId);
    const snap = await query.get();
    if (snap.empty) {
      exhausted = true;
      break;
    }

    for (const doc of snap.docs) {
      lastId = doc.id;
      scanned += 1;
      const row = classifyPerson(doc, nominaPersonIds);

      if (row.kind === 'keep') {
        keep += 1;
        continue;
      }
      if (row.kind === 'already_out') {
        alreadyOut += 1;
        continue;
      }

      await doc.ref.set({
        active: false,
        allowedDoorIds: [],
        deactivatedByRetainSources: true,
        deactivatedReason: 'not_nomina_or_biostar',
        deactivatedByRetainSourcesAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      deactivated += 1;
      if (sample.length < 10) sample.push({ id: row.id, name: row.name });
      if (deactivated >= size) break;
    }

    if (snap.size < 100) exhausted = true;
  }

  return {
    done: exhausted,
    cursor: lastId,
    deactivated,
    keep,
    alreadyOut,
    scanned,
    sample
  };
};

module.exports = {
  hasBiostarSignal,
  hasNominaSignal,
  shouldKeepPerson,
  loadNominaPersonIds,
  buildRetainSourcesPlan,
  applyRetainSourcesStep
};
