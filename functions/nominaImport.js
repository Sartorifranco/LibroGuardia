const { db, FieldValue } = require('./firestore');
const { parseNominaRow, buildNominaRowFromFields } = require('./lib/nominaParser');
const { buildAuthorizationRecord } = require('./authorizations');
const { resolveOrCreatePerson } = require('./people');
const { buildNameTokens } = require('./authorizations');

const buildMasterPayload = (personId, parsed, { active = true } = {}) => ({
  name: parsed.name,
  nameLower: parsed.name.toLowerCase(),
  nameKey: buildNameTokens(parsed.name),
  idNumber: parsed.idNumberNormalized || '',
  idNumberNormalized: parsed.idNumberNormalized || '',
  legajo: parsed.legajoNormalized || '',
  legajoNormalized: parsed.legajoNormalized || '',
  role: parsed.role || '',
  centroCosto: parsed.centroCosto || '',
  company: parsed.centroCosto || '',
  destination: parsed.centroCosto || '',
  turnoRaw: parsed.turnoRaw || '',
  shiftSchedule: parsed.shiftSchedule?.valid ? {
    daysOfWeek: parsed.shiftSchedule.daysOfWeek,
    timeWindow: parsed.shiftSchedule.timeWindow
  } : null,
  requiresCitacion: parsed.requiresCitacion === true,
  authorizationPolicy: parsed.authorizationPolicy,
  conCitacionRaw: parsed.conCitacionRaw || '',
  personId: personId || null,
  source: 'nomina',
  active: active !== false,
  updatedAt: FieldValue.serverTimestamp()
});

const upsertPersonalMaster = async (personId, parsed) => {
  let existing = null;

  if (parsed.legajoNormalized) {
    const snap = await db.collection('personalMaster')
      .where('legajoNormalized', '==', parsed.legajoNormalized)
      .limit(1)
      .get();
    if (!snap.empty) existing = snap.docs[0];
  }
  if (!existing && parsed.idNumberNormalized) {
    const snap = await db.collection('personalMaster')
      .where('idNumberNormalized', '==', parsed.idNumberNormalized)
      .limit(1)
      .get();
    if (!snap.empty) existing = snap.docs[0];
  }
  if (!existing) {
    const snap = await db.collection('personalMaster')
      .where('nameLower', '==', parsed.name.toLowerCase())
      .limit(1)
      .get();
    if (!snap.empty) existing = snap.docs[0];
  }

  const payload = buildMasterPayload(personId, parsed);

  if (existing) {
    await existing.ref.set(payload, { merge: true });
    return { id: existing.id, created: false, ...payload };
  }

  const ref = await db.collection('personalMaster').add({
    ...payload,
    createdAt: FieldValue.serverTimestamp()
  });
  return { id: ref.id, created: true, ...payload };
};

const syncNominaAuthorization = async (person, parsed) => {
  if (!person?.id) return null;

  const snap = await db.collection('authorizations')
    .where('personId', '==', person.id)
    .limit(50)
    .get();

  const existingDoc = snap.docs.find((doc) => {
    const data = doc.data();
    return data.source === 'nomina' && data.type === 'permanent';
  });

  if (!parsed.createPermanent) {
    if (existingDoc) {
      await existingDoc.ref.set({
        active: false,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return null;
  }

  const record = buildAuthorizationRecord({
    type: 'permanent',
    name: parsed.name,
    idNumber: parsed.idNumberNormalized,
    legajo: parsed.legajoNormalized,
    company: parsed.centroCosto,
    destination: parsed.centroCosto,
    role: parsed.role,
    personId: person.id,
    source: 'nomina',
    daysOfWeek: parsed.shiftSchedule?.daysOfWeek || null,
    timeWindow: parsed.shiftSchedule?.timeWindow || null,
    notes: `Nómina · ${parsed.authorizationPolicy}`
  });

  if (!existingDoc) {
    const ref = await db.collection('authorizations').add({
      ...record,
      createdAt: FieldValue.serverTimestamp()
    });
    return ref.id;
  }

  await existingDoc.ref.set({ ...record, active: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return existingDoc.id;
};

const applyParsedToPersonAndAuth = async (parsed) => {
  const person = await resolveOrCreatePerson({
    name: parsed.name,
    idNumber: parsed.idNumberNormalized,
    idNumberNormalized: parsed.idNumberNormalized,
    legajo: parsed.legajoNormalized,
    legajoNormalized: parsed.legajoNormalized,
    company: parsed.centroCosto,
    destination: parsed.centroCosto,
    role: parsed.role,
    centroCosto: parsed.centroCosto,
    turnoRaw: parsed.turnoRaw,
    shiftSchedule: parsed.shiftSchedule,
    requiresCitacion: parsed.requiresCitacion,
    authorizationPolicy: parsed.authorizationPolicy
  }, { origen: 'nomina', tipo: 'empleado', skipPersonalMasterSync: true });

  await syncNominaAuthorization(person, parsed);
  return person;
};

const saveNominaEmployee = async (fields = {}, { id } = {}) => {
  const parsed = parseNominaRow(buildNominaRowFromFields(fields));
  if (!parsed.valid) {
    const err = new Error(parsed.reason || 'Datos de nómina inválidos');
    err.code = 'invalid_nomina';
    err.reason = parsed.reason;
    throw err;
  }

  const person = await applyParsedToPersonAndAuth(parsed);
  const payload = buildMasterPayload(person.id, parsed, {
    active: fields.active === false ? false : true
  });

  if (id) {
    const ref = db.collection('personalMaster').doc(id);
    const existing = await ref.get();
    if (!existing.exists) {
      const err = new Error('Empleado de nómina no encontrado');
      err.code = 'not_found';
      throw err;
    }
    await ref.set(payload, { merge: true });
    return { id, created: false, ...payload };
  }

  return upsertPersonalMaster(person.id, parsed);
};

const deactivateNominaEmployee = async (id) => {
  const ref = db.collection('personalMaster').doc(id);
  const existing = await ref.get();
  if (!existing.exists) {
    const err = new Error('Empleado de nómina no encontrado');
    err.code = 'not_found';
    throw err;
  }

  const data = existing.data() || {};
  await ref.set({
    active: false,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  if (data.personId) {
    const authSnap = await db.collection('authorizations')
      .where('personId', '==', data.personId)
      .limit(50)
      .get();
    await Promise.all(authSnap.docs
      .filter((doc) => {
        const auth = doc.data();
        return auth.source === 'nomina' && auth.type === 'permanent';
      })
      .map((doc) => doc.ref.set({
        active: false,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })));
  }

  return { id, active: false, name: data.name || '' };
};

const trimNominaRowPayload = (row = {}) => {
  const cleaned = { ...row };
  Object.entries(cleaned).forEach(([key, value]) => {
    const normalizedKey = String(key || '').toLowerCase();
    if (normalizedKey.includes('tipo') && normalizedKey.includes('autoriz') && String(value).length > 120) {
      cleaned[key] = String(value).slice(0, 120);
    }
  });
  return cleaned;
};

const importNominaRows = async (rows = [], meta = {}) => {
  const stats = {
    total: rows.length,
    imported: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: []
  };

  const importRef = await db.collection('nominaImports').add({
    importedAt: FieldValue.serverTimestamp(),
    importedBy: meta.importedBy || 'admin',
    rowCount: rows.length,
    status: 'processing'
  });

  for (let index = 0; index < rows.length; index += 1) {
    const parsed = parseNominaRow(trimNominaRowPayload(rows[index]));
    if (!parsed.valid) {
      stats.skipped += 1;
      if (parsed.name || parsed.reason !== 'nombre_vacio') {
        stats.errors.push({ row: index + 1, reason: parsed.reason, name: parsed.name || '—' });
      }
      continue;
    }

    try {
      const person = await applyParsedToPersonAndAuth(parsed);
      const master = await upsertPersonalMaster(person.id, parsed);

      stats.imported += 1;
      if (master.created) stats.created += 1;
      else stats.updated += 1;
    } catch (err) {
      stats.skipped += 1;
      stats.errors.push({ row: index + 1, reason: err.message, name: parsed.name });
    }
  }

  await importRef.update({
    status: 'done',
    ...stats,
    finishedAt: FieldValue.serverTimestamp()
  });

  return { ...stats, importId: importRef.id };
};

const listNominaPersonal = async () => {
  const snap = await db.collection('personalMaster')
    .where('source', '==', 'nomina')
    .get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
};

module.exports = {
  importNominaRows,
  listNominaPersonal,
  upsertPersonalMaster,
  syncNominaAuthorization,
  saveNominaEmployee,
  deactivateNominaEmployee
};
