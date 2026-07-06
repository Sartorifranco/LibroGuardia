const crypto = require('crypto');
const { db, FieldValue } = require('./firestore');

const hashPayload = (data) =>
  crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

const findBatchByFileAndHash = async (sourceFile, sourceHash) => {
  const snap = await db.collection('importBatches')
    .where('sourceFile', '==', sourceFile)
    .where('sourceHash', '==', sourceHash)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
};

const findLatestBatchByFile = async (sourceFile) => {
  const snap = await db.collection('importBatches')
    .where('sourceFile', '==', sourceFile)
    .get();
  if (snap.empty) return null;
  return snap.docs.sort((a, b) => {
    const aTime = a.data().importedAt?.toMillis?.() || 0;
    const bTime = b.data().importedAt?.toMillis?.() || 0;
    return bTime - aTime;
  })[0];
};

const createImportBatch = async ({
  sourceFile,
  sourceHash,
  citacionDates,
  importedBy = 'bridge'
}) => {
  const ref = await db.collection('importBatches').add({
    sourceFile: sourceFile || null,
    sourceHash,
    storageRef: null,
    citacionDates: citacionDates || [],
    importedAt: FieldValue.serverTimestamp(),
    importedBy,
    status: 'processing',
    rowCount: 0,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    supersedes: null
  });
  return ref;
};

const finalizeImportBatch = async (batchRef, stats, { supersedes = null } = {}) => {
  await batchRef.update({
    status: stats.errorCount > 0 && stats.createdCount === 0 && stats.updatedCount === 0
      ? 'error'
      : 'done',
    rowCount: stats.rowCount,
    createdCount: stats.createdCount,
    updatedCount: stats.updatedCount,
    skippedCount: stats.skippedCount || 0,
    errorCount: stats.errorCount,
    supersedes,
    updatedAt: FieldValue.serverTimestamp()
  });
};

const writeImportRow = async (batchRef, rowData) => {
  await batchRef.collection('importRows').add({
    ...rowData,
    createdAt: FieldValue.serverTimestamp()
  });
};

const saveLegacyImportSnapshot = async (sourceFile, parsed, result, parseErrors = []) => {
  const citacionDates = [...new Set(parsed.map((row) => row.startDate).filter(Boolean))].sort();
  const rows = parsed.map((row) => ({
    legajo: row.legajoNormalized || row.legajo || '',
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    company: row.company || '',
    destination: row.destination || '',
    role: row.role || '',
    notes: row.notes || ''
  }));

  const ref = await db.collection('citacionesImports').add({
    sourceFile: sourceFile || null,
    importedAt: FieldValue.serverTimestamp(),
    citacionDates,
    rowCount: parsed.length,
    created: result.created,
    updated: result.updated,
    errorCount: parseErrors.length + result.errors.length,
    rows
  });

  return { id: ref.id, citacionDates, rowCount: parsed.length };
};

const listImportBatches = async ({ limit = 100 } = {}) => {
  const snap = await db.collection('importBatches')
    .orderBy('importedAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      sourceFile: data.sourceFile || null,
      sourceHash: data.sourceHash || null,
      importedAt: data.importedAt?.toDate ? data.importedAt.toDate().toISOString() : null,
      citacionDates: data.citacionDates || [],
      rowCount: data.rowCount || 0,
      created: data.createdCount || 0,
      updated: data.updatedCount || 0,
      errorCount: data.errorCount || 0,
      status: data.status || 'done',
      supersedes: data.supersedes || null
    };
  });
};

const getImportBatchById = async (batchId) => {
  const snap = await db.collection('importBatches').doc(batchId).get();
  if (!snap.exists) return null;

  const data = snap.data();
  const rowsSnap = await snap.ref.collection('importRows').get();
  const rows = rowsSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => String(a.appointmentDate).localeCompare(String(b.appointmentDate)));

  return {
    id: snap.id,
    sourceFile: data.sourceFile || null,
    sourceHash: data.sourceHash || null,
    importedAt: data.importedAt?.toDate ? data.importedAt.toDate().toISOString() : null,
    citacionDates: data.citacionDates || [],
    rowCount: data.rowCount || rows.length,
    created: data.createdCount || 0,
    updated: data.updatedCount || 0,
    errorCount: data.errorCount || 0,
    status: data.status || 'done',
    supersedes: data.supersedes || null,
    rows
  };
};

module.exports = {
  hashPayload,
  findBatchByFileAndHash,
  findLatestBatchByFile,
  createImportBatch,
  finalizeImportBatch,
  writeImportRow,
  saveLegacyImportSnapshot,
  listImportBatches,
  getImportBatchById
};
