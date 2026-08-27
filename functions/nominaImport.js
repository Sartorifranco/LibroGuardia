const { db, FieldValue } = require('./firestore');
const { parseNominaRow, buildNominaRowFromFields } = require('./lib/nominaParser');
const { buildAuthorizationRecord } = require('./authorizations');
const { resolveOrCreatePerson } = require('./people');
const { buildNameTokens } = require('./authorizations');
const {
  pickUpsertCandidate,
  buildReactivationFields,
  ambiguousPersonError
} = require('./lib/peopleUpsertMatch');

const buildMasterPayload = (personId, parsed, { active = true } = {}) => ({
  name: parsed.name,
  nameLower: parsed.name.toLowerCase(),
  nameKey: buildNameTokens(parsed.name),
  lastName: parsed.lastName || '',
  firstName: parsed.firstName || '',
  idNumber: parsed.idNumberNormalized || '',
  idNumberNormalized: parsed.idNumberNormalized || '',
  legajo: parsed.legajoNormalized || '',
  legajoNormalized: parsed.legajoNormalized || '',
  role: parsed.role || parsed.puesto || '',
  puesto: parsed.puesto || parsed.role || '',
  area: parsed.area || '',
  centroCosto: parsed.centroCosto || '',
  company: parsed.centroCosto || parsed.area || '',
  destination: parsed.centroCosto || parsed.area || '',
  email: parsed.email || '',
  phone: parsed.phone || '',
  cuil: parsed.cuil || '',
  birthDate: parsed.birthDate || null,
  sex: parsed.sex || '',
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
  active: active !== false && parsed.active !== false,
  updatedAt: FieldValue.serverTimestamp()
});

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

/** Auth de nómina con id estable: 1 write, sin query (crítico para no pasar 60s de Hosting). */
const syncNominaAuthorization = async (person, parsed) => {
  if (!person?.id) return null;
  const authRef = db.collection('authorizations').doc(`nomina-perm-${person.id}`);

  if (!parsed.createPermanent) {
    await authRef.set({
      active: false,
      source: 'nomina',
      type: 'permanent',
      personId: person.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return null;
  }

  const record = buildAuthorizationRecord({
    type: 'permanent',
    name: parsed.name,
    idNumber: parsed.idNumberNormalized,
    legajo: parsed.legajoNormalized,
    company: parsed.centroCosto || parsed.area,
    destination: parsed.centroCosto || parsed.area,
    role: parsed.role || parsed.puesto,
    personId: person.id,
    source: 'nomina',
    daysOfWeek: parsed.shiftSchedule?.daysOfWeek || null,
    timeWindow: parsed.shiftSchedule?.timeWindow || null,
    notes: `Nómina · ${parsed.authorizationPolicy}`
  });

  await authRef.set({
    ...record,
    active: true,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return authRef.id;
};

const applyParsedToPersonAndAuth = async (parsed) => {
  const person = await resolveOrCreatePerson({
    name: parsed.name,
    idNumber: parsed.idNumberNormalized,
    idNumberNormalized: parsed.idNumberNormalized,
    legajo: parsed.legajoNormalized,
    legajoNormalized: parsed.legajoNormalized,
    company: parsed.centroCosto || parsed.area,
    destination: parsed.centroCosto || parsed.area,
    role: parsed.role || parsed.puesto,
    puesto: parsed.puesto || parsed.role,
    area: parsed.area,
    centroCosto: parsed.centroCosto,
    email: parsed.email,
    phone: parsed.phone,
    cuil: parsed.cuil,
    birthDate: parsed.birthDate,
    sex: parsed.sex,
    turnoRaw: parsed.turnoRaw,
    shiftSchedule: parsed.shiftSchedule,
    requiresCitacion: parsed.requiresCitacion,
    authorizationPolicy: parsed.authorizationPolicy
  }, { origen: 'nomina', tipo: 'empleado', skipPersonalMasterSync: true });

  const enrich = {
    puesto: parsed.puesto || parsed.role || '',
    area: parsed.area || '',
    centroCosto: parsed.centroCosto || '',
    email: parsed.email || '',
    phone: parsed.phone || '',
    cuil: parsed.cuil || '',
    birthDate: parsed.birthDate || null,
    sex: parsed.sex || '',
    category: 'empleado',
    tipo: 'empleado',
    updatedAt: FieldValue.serverTimestamp()
  };
  if (parsed.active === false) {
    const snap = await db.collection('people').doc(person.id).get();
    const data = snap.data() || {};
    if (!data.biometricExternalId && data.source !== 'biostar') {
      enrich.active = false;
    }
  }
  await db.collection('people').doc(person.id).set(enrich, { merge: true });
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

const deactivateMissingNomina = async (keepKeys = { legajos: new Set(), dnis: new Set() }) => {
  const snap = await db.collection('personalMaster')
    .where('source', '==', 'nomina')
    .get();

  let deactivated = 0;
  let peopleDeactivated = 0;
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const legajo = String(data.legajoNormalized || data.legajo || '').trim();
    const dni = String(data.idNumberNormalized || data.idNumber || '').trim();
    const keep = (legajo && keepKeys.legajos.has(legajo))
      || (dni && keepKeys.dnis.has(dni));
    if (keep) continue;
    if (data.active === false) continue;

    batch.set(doc.ref, {
      active: false,
      deactivatedByReplaceAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    ops += 1;
    deactivated += 1;

    if (data.personId) {
      const personRef = db.collection('people').doc(data.personId);
      const personSnap = await personRef.get();
      if (personSnap.exists) {
        const p = personSnap.data() || {};
        const hasBio = Boolean(String(p.biometricExternalId || '').trim())
          || p.source === 'biostar'
          || p.biometricBrand === 'suprema';
        if (!hasBio && p.active !== false) {
          batch.set(personRef, {
            active: false,
            updatedAt: FieldValue.serverTimestamp(),
            deactivatedByNominaReplace: true
          }, { merge: true });
          ops += 1;
          peopleDeactivated += 1;
        }
      }
      const authSnap = await db.collection('authorizations')
        .where('personId', '==', data.personId)
        .limit(50)
        .get();
      authSnap.docs.forEach((a) => {
        const auth = a.data();
        if (auth.source === 'nomina' && auth.type === 'permanent' && auth.active !== false) {
          batch.set(a.ref, {
            active: false,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          ops += 1;
        }
      });
    }

    if (ops >= 400) await flush();
  }

  await flush();
  return { deactivated, peopleDeactivated };
};

const findMasterDoc = async (parsed, caches) => {
  if (parsed.legajoNormalized && caches.masterByLegajo.has(parsed.legajoNormalized)) {
    return caches.masterByLegajo.get(parsed.legajoNormalized);
  }
  if (parsed.idNumberNormalized && caches.masterByDni.has(parsed.idNumberNormalized)) {
    return caches.masterByDni.get(parsed.idNumberNormalized);
  }
  if (parsed.name && caches.masterByName.has(parsed.name.toLowerCase())) {
    return caches.masterByName.get(parsed.name.toLowerCase());
  }

  let snap = null;
  if (parsed.legajoNormalized) {
    snap = await db.collection('personalMaster')
      .where('legajoNormalized', '==', parsed.legajoNormalized)
      .limit(1)
      .get();
  }
  if ((!snap || snap.empty) && parsed.idNumberNormalized) {
    snap = await db.collection('personalMaster')
      .where('idNumberNormalized', '==', parsed.idNumberNormalized)
      .limit(1)
      .get();
  }
  if ((!snap || snap.empty) && parsed.name) {
    snap = await db.collection('personalMaster')
      .where('nameLower', '==', parsed.name.toLowerCase())
      .limit(1)
      .get();
  }
  if (!snap || snap.empty) return null;

  const doc = snap.docs[0];
  const row = { id: doc.id, ref: doc.ref, data: doc.data() || {} };
  if (parsed.legajoNormalized) caches.masterByLegajo.set(parsed.legajoNormalized, row);
  if (parsed.idNumberNormalized) caches.masterByDni.set(parsed.idNumberNormalized, row);
  if (parsed.name) caches.masterByName.set(parsed.name.toLowerCase(), row);
  return row;
};

const upsertPersonalMasterCached = async (personId, parsed, caches) => {
  const existing = await findMasterDoc(parsed, caches);
  const payload = buildMasterPayload(personId, parsed);

  if (existing) {
    await existing.ref.set(payload, { merge: true });
    const row = { id: existing.id, ref: existing.ref, data: { ...existing.data, ...payload } };
    if (parsed.legajoNormalized) caches.masterByLegajo.set(parsed.legajoNormalized, row);
    if (parsed.idNumberNormalized) caches.masterByDni.set(parsed.idNumberNormalized, row);
    caches.masterByName.set(parsed.name.toLowerCase(), row);
    return { id: existing.id, created: false, ...payload };
  }

  const ref = await db.collection('personalMaster').add({
    ...payload,
    createdAt: FieldValue.serverTimestamp()
  });
  const row = { id: ref.id, ref, data: payload };
  if (parsed.legajoNormalized) caches.masterByLegajo.set(parsed.legajoNormalized, row);
  if (parsed.idNumberNormalized) caches.masterByDni.set(parsed.idNumberNormalized, row);
  caches.masterByName.set(parsed.name.toLowerCase(), row);
  return { id: ref.id, created: true, ...payload };
};

const findPeopleDoc = async (parsed, caches) => {
  if (parsed.legajoNormalized && caches.peopleByLegajo.has(parsed.legajoNormalized)) {
    return caches.peopleByLegajo.get(parsed.legajoNormalized);
  }
  if (parsed.idNumberNormalized && caches.peopleByDni.has(parsed.idNumberNormalized)) {
    return caches.peopleByDni.get(parsed.idNumberNormalized);
  }

  const loadByField = async (field, value) => {
    if (!value) return [];
    const snap = await db.collection('people').where(field, '==', value).get();
    return snap.docs;
  };

  let docs = [];
  if (parsed.legajoNormalized) {
    docs = await loadByField('legajoNormalized', parsed.legajoNormalized);
  }
  if (!docs.length && parsed.idNumberNormalized) {
    const byIdNum = await loadByField('idNumberNormalized', parsed.idNumberNormalized);
    const byDni = await loadByField('dniNormalized', parsed.idNumberNormalized);
    const byId = new Map();
    [...byIdNum, ...byDni].forEach((d) => byId.set(d.id, d));
    docs = [...byId.values()];
  }

  const picked = pickUpsertCandidate(docs, {
    legajoNormalized: parsed.legajoNormalized,
    dniNormalized: parsed.idNumberNormalized
  });
  if (picked.status === 'ambiguous') {
    throw ambiguousPersonError(picked.reason);
  }
  if (picked.status === 'none') return null;

  const row = {
    id: picked.candidate.id,
    ref: picked.candidate.ref,
    data: picked.candidate.data
  };
  if (parsed.legajoNormalized) caches.peopleByLegajo.set(parsed.legajoNormalized, row);
  if (parsed.idNumberNormalized) caches.peopleByDni.set(parsed.idNumberNormalized, row);
  return row;
};

const resolvePersonCached = async (parsed, caches) => {
  const hit = await findPeopleDoc(parsed, caches);

  const enrich = {
    nombre: parsed.name,
    name: parsed.name,
    nameLower: parsed.name.toLowerCase(),
    nameKey: buildNameTokens(parsed.name),
    nameTokens: buildNameTokens(parsed.name),
    dni: parsed.idNumberNormalized || null,
    dniNormalized: parsed.idNumberNormalized || null,
    idNumber: parsed.idNumberNormalized || '',
    idNumberNormalized: parsed.idNumberNormalized || '',
    legajo: parsed.legajoNormalized || null,
    legajoNormalized: parsed.legajoNormalized || null,
    company: parsed.centroCosto || parsed.area || '',
    destination: parsed.centroCosto || parsed.area || '',
    centroCosto: parsed.centroCosto || '',
    area: parsed.area || '',
    puesto: parsed.puesto || parsed.role || '',
    email: parsed.email || '',
    phone: parsed.phone || '',
    cuil: parsed.cuil || '',
    birthDate: parsed.birthDate || null,
    sex: parsed.sex || '',
    category: 'empleado',
    tipo: 'empleado',
    origen: 'nomina',
    updatedAt: FieldValue.serverTimestamp()
  };

  if (hit) {
    const existing = hit.data || {};
    if (parsed.active === false
      && !existing.biometricExternalId
      && existing.source !== 'biostar'
      && existing.biometricBrand !== 'suprema') {
      enrich.active = false;
    } else if (parsed.active !== false) {
      Object.assign(enrich, buildReactivationFields(existing, {
        wantActive: parsed.active !== false,
        via: 'nomina',
        timestamp: FieldValue.serverTimestamp()
      }));
    }
    if (existing.origen && existing.origen !== 'nomina') enrich.origen = existing.origen;
    if (existing.source) enrich.source = existing.source;
    await hit.ref.set(enrich, { merge: true });
    const person = { id: hit.id, ...existing, ...enrich };
    if (parsed.legajoNormalized) {
      caches.peopleByLegajo.set(parsed.legajoNormalized, { id: hit.id, ref: hit.ref, data: person });
    }
    if (parsed.idNumberNormalized) {
      caches.peopleByDni.set(parsed.idNumberNormalized, { id: hit.id, ref: hit.ref, data: person });
    }
    return person;
  }

  const ref = await db.collection('people').add({
    ...enrich,
    active: parsed.active !== false,
    createdAt: FieldValue.serverTimestamp()
  });
  const person = { id: ref.id, ...enrich, active: parsed.active !== false };
  if (parsed.legajoNormalized) {
    caches.peopleByLegajo.set(parsed.legajoNormalized, { id: ref.id, ref, data: person });
  }
  if (parsed.idNumberNormalized) {
    caches.peopleByDni.set(parsed.idNumberNormalized, { id: ref.id, ref, data: person });
  }
  return person;
};

/** Caches vacíos: master/people se resuelven on-demand por query (evita lecturas masivas). */
const loadImportCaches = async () => ({
  masterByLegajo: new Map(),
  masterByDni: new Map(),
  masterByName: new Map(),
  peopleByLegajo: new Map(),
  peopleByDni: new Map()
});

const mapPool = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
};

/**
 * Import rápido por lotes internos (compat). Preferí createNominaImportJob + processNominaImportStep.
 */
const importNominaRows = async (rows = [], meta = {}) => {
  const job = await createNominaImportJob(rows, meta);
  let result = null;
  do {
    result = await processNominaImportStep(job.jobId, { batchSize: 5, concurrency: 2 });
  } while (!result.done);
  return {
    total: result.total,
    imported: result.imported,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    deactivated: result.deactivated,
    peopleDeactivated: result.peopleDeactivated || 0,
    errors: result.errors || [],
    replace: meta.replace === true,
    importId: job.jobId
  };
};

const emptyStats = () => ({
  imported: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  deactivated: 0,
  peopleDeactivated: 0,
  errors: []
});

/**
 * Límites operativos del job. Mantener micro-lotes es una protección contra el
 * timeout de ~60 s del proxy de Hosting, no una preferencia de performance.
 */
const normalizeImportStepOptions = ({ batchSize = 5, concurrency = 2 } = {}) => ({
  batchSize: Math.max(1, Math.min(10, Number(batchSize) || 5)),
  concurrency: Math.max(1, Math.min(3, Number(concurrency) || 2))
});

const createNominaImportJob = async (rows = [], meta = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const keepLegajos = [
    ...(Array.isArray(meta.keepLegajos) ? meta.keepLegajos : []),
    ...list.map((r) => String(r.Legajo ?? r.legajo ?? '').trim()).filter(Boolean)
  ];
  const keepDnis = [
    ...(Array.isArray(meta.keepDnis) ? meta.keepDnis : []),
    ...list.map((r) => String(r.DNI ?? r.dni ?? r.Documento ?? '').replace(/\D/g, '')).filter(Boolean)
  ];

  const ref = await db.collection('nominaImports').add({
    importedAt: FieldValue.serverTimestamp(),
    importedBy: meta.importedBy || 'admin',
    rowCount: list.length,
    replace: meta.replace === true,
    keepLegajos: [...new Set(keepLegajos)],
    keepDnis: [...new Set(keepDnis)],
    status: 'queued',
    cursor: 0,
    stats: emptyStats(),
    rows: list
  });

  return { jobId: ref.id, rowCount: list.length };
};

const finalizeNominaReplace = async (job, stats) => {
  if (job.replace !== true) {
    return { ...stats, deactivated: stats.deactivated || 0, peopleDeactivated: stats.peopleDeactivated || 0 };
  }
  const wiped = await deactivateMissingNomina({
    legajos: new Set(job.keepLegajos || []),
    dnis: new Set(job.keepDnis || [])
  });
  return {
    ...stats,
    deactivated: wiped.deactivated,
    peopleDeactivated: wiped.peopleDeactivated
  };
};

const processNominaImportStep = async (jobId, { batchSize = 5, concurrency = 2 } = {}) => {
  const ref = db.collection('nominaImports').doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Trabajo de importación no encontrado');
    err.code = 'not_found';
    throw err;
  }

  const job = snap.data() || {};
  if (job.status === 'done' || job.status === 'failed') {
    return {
      done: true,
      status: job.status,
      total: job.rowCount || 0,
      processed: job.cursor || 0,
      ...(job.stats || emptyStats()),
      importId: jobId
    };
  }

  const rows = Array.isArray(job.rows) ? job.rows : [];
  const cursor = Number(job.cursor) || 0;
  const stats = { ...emptyStats(), ...(job.stats || {}) };
  if (!Array.isArray(stats.errors)) stats.errors = [];

  // Paso aparte: replace/bajas (no mezclar con upserts → evita 502 por timeout Hosting 60s).
  if (job.status === 'finalizing') {
    const finalStats = await finalizeNominaReplace(job, stats);
    await ref.set({
      status: 'done',
      cursor: rows.length || job.rowCount || cursor,
      stats: finalStats,
      rows: FieldValue.delete(),
      finishedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return {
      done: true,
      status: 'done',
      total: job.rowCount || rows.length,
      processed: job.rowCount || rows.length,
      ...finalStats,
      importId: jobId
    };
  }

  if (cursor >= rows.length) {
    await ref.set({ status: 'finalizing' }, { merge: true });
    return {
      done: false,
      status: 'finalizing',
      total: rows.length || job.rowCount || 0,
      processed: cursor,
      ...stats,
      importId: jobId
    };
  }

  const options = normalizeImportStepOptions({ batchSize, concurrency });
  const size = options.batchSize;
  const slice = rows.slice(cursor, cursor + size);
  if (!slice.length) {
    await ref.set({ status: 'finalizing' }, { merge: true });
    return {
      done: false,
      status: 'finalizing',
      total: rows.length,
      processed: cursor,
      ...stats,
      importId: jobId
    };
  }

  const caches = await loadImportCaches();
  await ref.set({ status: 'processing' }, { merge: true });

  const outcomes = await mapPool(slice, options.concurrency, async (row, index) => {
    const parsed = parseNominaRow(trimNominaRowPayload(row));
    if (!parsed.valid) {
      return {
        ok: false,
        skipped: true,
        error: (parsed.name || parsed.reason !== 'nombre_vacio')
          ? { row: cursor + index + 1, reason: parsed.reason, name: parsed.name || '—' }
          : null
      };
    }
    try {
      const person = await resolvePersonCached(parsed, caches);
      const master = await upsertPersonalMasterCached(person.id, parsed, caches);
      await syncNominaAuthorization(person, parsed);
      return {
        ok: true,
        created: master.created,
        legajo: parsed.legajoNormalized || '',
        dni: parsed.idNumberNormalized || ''
      };
    } catch (err) {
      return {
        ok: false,
        skipped: true,
        error: { row: cursor + index + 1, reason: err.message, name: parsed.name }
      };
    }
  });

  const keepLegajos = new Set(job.keepLegajos || []);
  const keepDnis = new Set(job.keepDnis || []);
  outcomes.forEach((out) => {
    if (!out) return;
    if (out.ok) {
      stats.imported += 1;
      if (out.created) stats.created += 1;
      else stats.updated += 1;
      if (out.legajo) keepLegajos.add(out.legajo);
      if (out.dni) keepDnis.add(out.dni);
    } else if (out.skipped) {
      stats.skipped += 1;
      if (out.error) stats.errors.push(out.error);
    }
  });

  const nextCursor = cursor + slice.length;
  const finishedRows = nextCursor >= rows.length;

  await ref.set({
    status: finishedRows ? 'finalizing' : 'processing',
    cursor: nextCursor,
    keepLegajos: [...keepLegajos],
    keepDnis: [...keepDnis],
    stats
  }, { merge: true });

  return {
    done: false,
    status: finishedRows ? 'finalizing' : 'processing',
    total: rows.length,
    processed: nextCursor,
    ...stats,
    importId: jobId
  };
};

const listNominaPersonal = async () => {
  const snap = await db.collection('personalMaster')
    .where('source', '==', 'nomina')
    .get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
};

const listNominaBirthdays = async ({ withinDays = 0 } = {}) => {
  const days = Math.max(0, Math.min(14, Number(withinDays) || 0));
  const all = await listNominaPersonal();
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const d = today.getDate();

  const results = [];
  for (const emp of all) {
    if (emp.active === false) continue;
    const bd = String(emp.birthDate || '').trim();
    const match = bd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) continue;
    const bm = Number(match[2]);
    const bdDay = Number(match[3]);
    let cand;
    try {
      cand = new Date(y, bm - 1, bdDay);
    } catch {
      continue;
    }
    const todayMid = new Date(y, m - 1, d);
    let delta = Math.round((cand - todayMid) / 86400000);
    if (delta < 0 && days > 0) {
      cand = new Date(y + 1, bm - 1, bdDay);
      delta = Math.round((cand - todayMid) / 86400000);
    }
    if (delta < 0 || delta > days) continue;
    results.push({
      id: emp.id,
      name: emp.name,
      legajo: emp.legajoNormalized || emp.legajo || '',
      area: emp.area || '',
      puesto: emp.puesto || emp.role || '',
      birthDate: emp.birthDate,
      daysUntil: delta,
      isToday: delta === 0
    });
  }
  results.sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name));
  return results;
};

module.exports = {
  importNominaRows,
  createNominaImportJob,
  processNominaImportStep,
  listNominaPersonal,
  listNominaBirthdays,
  upsertPersonalMaster,
  syncNominaAuthorization,
  saveNominaEmployee,
  deactivateNominaEmployee,
  deactivateMissingNomina,
  buildMasterPayload,
  normalizeImportStepOptions,
  resolvePersonCached
};
