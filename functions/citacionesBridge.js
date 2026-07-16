const { db, FieldValue } = require('./firestore');
const { parseImportRows, buildMasterLookups } = require('./citacionesImport');
const { resolveOrCreatePerson } = require('./people');
const { todayDateString } = require('./authorizations');
const { normalizeIdNumber } = require('./dniParser');
const { buildNameTokens } = require('./lib/nameUtils');
const {
  buildNominaEmployeeIndex,
  matchCitacionToEmployee,
  normalizeLegajo
} = require('./lib/personMatch');
const { applyTransportParseToCitacion } = require('./lib/transportCsvParser');
const {
  hashPayload,
  findBatchByFileAndHash,
  findLatestBatchByFile,
  createImportBatch,
  finalizeImportBatch,
  writeImportRow,
  saveLegacyImportSnapshot,
  listImportBatches,
  getImportBatchById
} = require('./importBatches');
const DEFAULT_CITACIONES_BRIDGE = {
  enabled: false,
  bridgeSecret: '',
  watchFolderHint: 'C:\\usr',
  lastSyncAt: null,
  lastSyncFile: null,
  lastSyncCount: 0,
  lastSyncError: null
};

const getCitacionesBridgeConfig = async () => {
  const snap = await db.collection('settings').doc('citacionesBridge').get();
  if (!snap.exists) return { ...DEFAULT_CITACIONES_BRIDGE };
  const data = snap.data();
  return {
    ...DEFAULT_CITACIONES_BRIDGE,
    ...data,
    lastSyncAt: data.lastSyncAt?.toDate ? data.lastSyncAt.toDate().toISOString() : data.lastSyncAt || null
  };
};

const saveCitacionesBridgeConfig = async (updates) => {
  const payload = { ...updates, updatedAt: FieldValue.serverTimestamp() };
  await db.collection('settings').doc('citacionesBridge').set(payload, { merge: true });
  return getCitacionesBridgeConfig();
};

const verifyCitacionesBridgeRequest = async (req) => {
  const config = await getCitacionesBridgeConfig();
  if (!config.enabled) {
    const error = new Error('Puente de citaciones deshabilitado');
    error.status = 503;
    throw error;
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!config.bridgeSecret || token !== config.bridgeSecret) {
    const error = new Error('Secreto de puente inválido');
    error.status = 401;
    throw error;
  }
  return config;
};

const isPollutedDateIdNumber = (idNumberNormalized, startDate) => {
  const dni = String(idNumberNormalized || '').replace(/\D/g, '');
  const dateDigits = String(startDate || '').replace(/\D/g, '');
  return Boolean(dni && dateDigits && dni === dateDigits);
};

const findExistingAuthorization = async (record) => {
  if (record.legajoNormalized) {
    const byLegajo = await db.collection('authorizations')
      .where('legajoNormalized', '==', record.legajoNormalized)
      .where('type', '==', record.type)
      .where('startDate', '==', record.startDate)
      .where('active', '==', true)
      .limit(1)
      .get();
    if (!byLegajo.empty) return byLegajo.docs[0];
  }

  // No matchear por DNI si es la fecha de citación (bug histórico: 2026-07-16 → 20260716).
  if (record.idNumberNormalized && !isPollutedDateIdNumber(record.idNumberNormalized, record.startDate)) {
    const byDni = await db.collection('authorizations')
      .where('idNumberNormalized', '==', record.idNumberNormalized)
      .where('type', '==', record.type)
      .where('startDate', '==', record.startDate)
      .where('active', '==', true)
      .limit(1)
      .get();
    if (!byDni.empty) return byDni.docs[0];
  }

  if (record.nameKey || record.nameTokens) {
    const nameKey = record.nameKey || record.nameTokens;
    const byName = await db.collection('authorizations')
      .where('nameKey', '==', nameKey)
      .where('type', '==', record.type)
      .where('startDate', '==', record.startDate)
      .where('active', '==', true)
      .limit(1)
      .get();
    if (!byName.empty) return byName.docs[0];
  }

  return null;
};

const deactivateOrphanAuthorizations = async (previousBatchId, previousDates, newKeys) => {
  if (!previousBatchId || !previousDates?.length) return 0;

  const snap = await db.collection('authorizations')
    .where('importBatchId', '==', previousBatchId)
    .where('active', '==', true)
    .get();

  let deactivated = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!previousDates.includes(data.startDate)) continue;
    const key = `${data.legajoNormalized || ''}|${data.startDate}|${data.nameKey || data.nameTokens || ''}`;
    if (newKeys.has(key)) continue;
    await doc.ref.update({
      active: false,
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: 'import_superseded',
      updatedAt: FieldValue.serverTimestamp()
    });
    deactivated += 1;
  }
  return deactivated;
};

const upsertAuthorizationRows = async (rows, meta = {}) => {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  const newKeys = new Set();

  for (let index = 0; index < rows.length; index += 1) {
    const record = rows[index];
    try {
      const person = await resolveOrCreatePerson(record, { origen: 'import', tipo: 'empleado' });
      const existing = await findExistingAuthorization(record);
      const payload = {
        ...record,
        personId: person.id,
        source: 'import',
        importBatchId: meta.importBatchId || null,
        importSource: meta.sourceFile || meta.source || 'bridge',
        active: true,
        importedAt: FieldValue.serverTimestamp(),
        updatedBy: meta.importedBy || 'bridge'
      };

      newKeys.add(`${record.legajoNormalized || ''}|${record.startDate}|${record.nameKey || record.nameTokens || ''}`);

      let authorizationId;
      if (existing) {
        await existing.ref.update(payload);
        authorizationId = existing.id;
        updated += 1;
        await writeImportRow(meta.batchRef, {
          legajo: record.legajoNormalized,
          nombre: record.name,
          appointmentDate: record.startDate,
          destination: record.destination,
          role: record.role || '',
          resolvedPersonId: person.id,
          resolvedAuthorizationId: authorizationId,
          status: 'updated'
        });
      } else {
        const ref = await db.collection('authorizations').add({
          ...payload,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: meta.importedBy || 'bridge'
        });
        authorizationId = ref.id;
        created += 1;
        await writeImportRow(meta.batchRef, {
          legajo: record.legajoNormalized,
          nombre: record.name,
          appointmentDate: record.startDate,
          destination: record.destination,
          role: record.role || '',
          resolvedPersonId: person.id,
          resolvedAuthorizationId: authorizationId,
          status: 'created'
        });
      }
    } catch (err) {
      errors.push({ row: index + 1, message: err.message });
      if (meta.batchRef) {
        await writeImportRow(meta.batchRef, {
          legajo: record.legajoNormalized || '',
          nombre: record.name || '',
          appointmentDate: record.startDate || '',
          destination: record.destination || '',
          role: record.role || '',
          resolvedPersonId: null,
          resolvedAuthorizationId: null,
          status: 'error',
          errorMessage: err.message
        });
      }
    }
  }

  return { created, updated, skipped, errors, newKeys };
};

const listCitacionesImports = async ({ limit = 100 } = {}) => {
  const batches = await listImportBatches({ limit });
  if (batches.length) return batches;

  const snap = await db.collection('citacionesImports')
    .orderBy('importedAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      sourceFile: data.sourceFile || null,
      importedAt: data.importedAt?.toDate ? data.importedAt.toDate().toISOString() : null,
      citacionDates: data.citacionDates || [],
      rowCount: data.rowCount || 0,
      created: data.created || 0,
      updated: data.updated || 0,
      errorCount: data.errorCount || 0,
      legacy: true
    };
  });
};

const getCitacionesImportById = async (importId) => {
  const batch = await getImportBatchById(importId);
  if (batch) return batch;

  const snap = await db.collection('citacionesImports').doc(importId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return {
    id: snap.id,
    sourceFile: data.sourceFile || null,
    importedAt: data.importedAt?.toDate ? data.importedAt.toDate().toISOString() : null,
    citacionDates: data.citacionDates || [],
    rowCount: data.rowCount || 0,
    created: data.created || 0,
    updated: data.updated || 0,
    errorCount: data.errorCount || 0,
    rows: data.rows || [],
    legacy: true
  };
};

const importRowsToBridgePayload = (rows = []) =>
  rows.map((row) => ({
    per__des: row.nombre || row.name || '',
    legajo: row.legajo || '',
    diacitacioningreso: row.appointmentDate || row.startDate || '',
    sector__des: row.destination || '',
    tarcon__des: row.role || '',
    observaciones: row.notes || ''
  }));

const relinkCitacionesWithNomina = async ({ dateString } = {}) => {
  const targetDate = dateString || todayDateString();

  const personalSnap = await db.collection('personalMaster').where('source', '==', 'nomina').get();
  const employees = personalSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((employee) => employee.active !== false);
  const index = buildNominaEmployeeIndex(employees);

  const snap = await db.collection('authorizations')
    .where('active', '==', true)
    .where('type', '==', 'citacion')
    .get();

  let linked = 0;
  let unchanged = 0;
  let unmatched = 0;
  let matchedNomina = 0;
  let processed = 0;
  const unmatchedSample = [];
  let parsedCsv = 0;

  for (const doc of snap.docs) {
    const raw = { id: doc.id, ...doc.data() };
    if ((raw.appointmentDate || raw.startDate) !== targetDate) continue;

    processed += 1;
    const citacion = applyTransportParseToCitacion(raw);
    const parsedChanged = citacion.name !== raw.name
      || citacion.legajo !== raw.legajo
      || citacion.destination !== raw.destination;

    const employee = matchCitacionToEmployee(citacion, index);

    const legajoNormalized = employee
      ? normalizeLegajo(employee.legajoNormalized || employee.legajo)
      : normalizeLegajo(citacion.legajoNormalized || citacion.legajo);
    const idNumberNormalized = employee
      ? (employee.idNumberNormalized || normalizeIdNumber(employee.idNumber))
      : (citacion.idNumberNormalized || normalizeIdNumber(citacion.idNumber));
    const resolvedName = employee?.name || citacion.name;
    const nameKey = employee?.nameKey || buildNameTokens(resolvedName);

    const updates = {
      legajo: employee?.legajoNormalized || employee?.legajo || citacion.legajo,
      legajoNormalized,
      idNumber: idNumberNormalized || citacion.idNumber || '',
      idNumberNormalized: idNumberNormalized || '',
      name: resolvedName,
      nameKey,
      destination: citacion.destination || raw.destination || '',
      company: citacion.company || raw.company || '',
      role: citacion.role || raw.role || '',
      appointmentTime: citacion.appointmentTime || raw.appointmentTime || null,
      updatedAt: FieldValue.serverTimestamp()
    };

    const alreadyOk = raw.legajoNormalized === legajoNormalized
      && raw.name === resolvedName
      && raw.destination === updates.destination
      && (raw.appointmentTime || null) === (updates.appointmentTime || null)
      && (employee ? raw.idNumberNormalized === idNumberNormalized : true);

    if (alreadyOk) {
      if (employee) matchedNomina += 1;
      else unmatched += 1;
      unchanged += 1;
      continue;
    }

    if (parsedChanged && !employee) parsedCsv += 1;

    if (employee) {
      updates.personId = employee.personId || citacion.personId || null;
      matchedNomina += 1;
    } else {
      unmatched += 1;
      if (unmatchedSample.length < 8) {
        unmatchedSample.push({
          name: resolvedName || '',
          legajo: legajoNormalized || ''
        });
      }
    }

    await doc.ref.update({
      ...updates,
      relinkedAt: FieldValue.serverTimestamp()
    });
    linked += 1;
  }

  return {
    date: targetDate,
    processed,
    linked,
    unchanged,
    unmatched,
    parsedCsv,
    matchedNomina,
    totalNomina: employees.length,
    unmatchedSample,
    message: linked
      ? `${linked} citación(es) actualizada(s)${parsedCsv ? ` (${parsedCsv} parseadas desde CSV)` : ''}`
      : unmatched
        ? `${unmatched} citación(es) sin match en nómina (${processed} procesadas)`
        : `${unchanged} citación(es) ya estaban vinculadas`
  };
};

const reprocessImportBatch = async (batchId, { force = true } = {}) => {
  const batch = await getImportBatchById(batchId);
  const rows = batch?.rows?.length
    ? batch.rows
    : (await getCitacionesImportById(batchId))?.rows;

  if (!rows?.length) {
    const error = new Error('Importación sin filas para reprocesar');
    error.status = 404;
    throw error;
  }

  const sourceFile = batch?.sourceFile
    || (await getCitacionesImportById(batchId))?.sourceFile
    || `reprocess-${batchId}.xlsx`;

  return syncAuthorizationsFromBridge({
    data: importRowsToBridgePayload(rows),
    sourceFile,
    force
  });
};

const syncAuthorizationsFromBridge = async (payload = {}) => {
  const { data, sourceFile, defaults, force = false } = payload;
  if (!Array.isArray(data) || data.length === 0) {
    const error = new Error('Se espera un array no vacío de filas');
    error.status = 400;
    throw error;
  }

  const masterSnap = await db.collection('personalMaster').where('source', '==', 'nomina').get();
  const { masterByLegajo, masterByName, masterByNameKey, masterList } = buildMasterLookups(masterSnap.docs);

  const mergedDefaults = {
    ...(defaults || {}),
    sourceFile,
    masterByLegajo,
    masterByName,
    masterByNameKey,
    masterList
  };

  const { parsed, errors: parseErrors } = parseImportRows(data, mergedDefaults);
  if (!parsed.length) {
    const error = new Error(
      parseErrors[0]?.message
        || 'No se encontraron filas válidas. Formato transporte: legajo, per__des, sector__des, diacitacioningreso'
    );
    error.status = 400;
    error.details = parseErrors;
    throw error;
  }

  const sourceHash = hashPayload({ sourceFile, data });
  const existingBatch = !force && sourceFile
    ? await findBatchByFileAndHash(sourceFile, sourceHash)
    : null;

  if (existingBatch) {
    return {
      message: 'Planilla ya importada (sin cambios)',
      importId: existingBatch.id,
      citacionDates: existingBatch.data().citacionDates || [],
      created: 0,
      updated: 0,
      skippedDuplicate: true,
      count: 0
    };
  }

  const citacionDates = [...new Set(parsed.map((row) => row.startDate).filter(Boolean))].sort();
  const previousBatch = sourceFile ? await findLatestBatchByFile(sourceFile) : null;
  const batchRef = await createImportBatch({
    sourceFile,
    sourceHash,
    citacionDates,
    importedBy: 'bridge'
  });

  if (previousBatch && previousBatch.data().sourceHash !== sourceHash) {
    await batchRef.update({ supersedes: previousBatch.id });
  }

  const result = await upsertAuthorizationRows(parsed, {
    sourceFile,
    importBatchId: batchRef.id,
    batchRef,
    importedBy: 'bridge'
  });

  let deactivated = 0;
  if (previousBatch && previousBatch.data().sourceHash !== sourceHash) {
    deactivated = await deactivateOrphanAuthorizations(
      previousBatch.id,
      previousBatch.data().citacionDates || [],
      result.newKeys
    );
  }

  await finalizeImportBatch(batchRef, {
    rowCount: parsed.length,
    createdCount: result.created,
    updatedCount: result.updated,
    skippedCount: result.skipped,
    errorCount: parseErrors.length + result.errors.length
  }, {
    supersedes: previousBatch && previousBatch.data().sourceHash !== sourceHash
      ? previousBatch.id
      : null
  });

  const legacyImport = await saveLegacyImportSnapshot(sourceFile, parsed, result, parseErrors);
  const total = result.created + result.updated;
  await saveCitacionesBridgeConfig({
    lastSyncAt: FieldValue.serverTimestamp(),
    lastSyncFile: sourceFile || null,
    lastSyncCount: total,
    lastSyncError: result.errors.length
      ? `${result.errors.length} fila(s) con error`
      : parseErrors.length
        ? `${parseErrors.length} fila(s) omitida(s)`
        : null
  });

  return {
    message: `${total} autorización(es) sincronizadas (${result.created} nuevas, ${result.updated} actualizadas${deactivated ? `, ${deactivated} revocadas por corrección` : ''})`,
    importId: batchRef.id,
    legacyImportId: legacyImport.id,
    citacionDates,
    created: result.created,
    updated: result.updated,
    deactivated,
    skippedInvalid: parseErrors.length,
    rowErrors: [...parseErrors, ...result.errors],
    count: total
  };
};
module.exports = {
  DEFAULT_CITACIONES_BRIDGE,
  getCitacionesBridgeConfig,
  saveCitacionesBridgeConfig,
  verifyCitacionesBridgeRequest,
  syncAuthorizationsFromBridge,
  relinkCitacionesWithNomina,
  reprocessImportBatch,
  listCitacionesImports,
  getCitacionesImportById,
  parseImportRows,
  upsertAuthorizationRows
};
