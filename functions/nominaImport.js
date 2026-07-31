const { db, FieldValue } = require('./firestore');
const { parseNominaRow, buildNominaRowFromFields } = require('./lib/nominaParser');
const { buildAuthorizationRecord } = require('./authorizations');
const { resolveOrCreatePerson } = require('./people');
const { buildNameTokens } = require('./authorizations');

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
    company: parsed.centroCosto || parsed.area,
    destination: parsed.centroCosto || parsed.area,
    role: parsed.role || parsed.puesto,
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

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const legajo = String(data.legajoNormalized || data.legajo || '').trim();
    const dni = String(data.idNumberNormalized || data.idNumber || '').trim();
    const keep = (legajo && keepKeys.legajos.has(legajo))
      || (dni && keepKeys.dnis.has(dni));
    if (keep) continue;
    if (data.active === false) continue;

    await doc.ref.set({
      active: false,
      deactivatedByReplaceAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
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
          await personRef.set({
            active: false,
            updatedAt: FieldValue.serverTimestamp(),
            deactivatedByNominaReplace: true
          }, { merge: true });
          peopleDeactivated += 1;
        }
      }
      const authSnap = await db.collection('authorizations')
        .where('personId', '==', data.personId)
        .limit(50)
        .get();
      await Promise.all(authSnap.docs
        .filter((a) => {
          const auth = a.data();
          return auth.source === 'nomina' && auth.type === 'permanent' && auth.active !== false;
        })
        .map((a) => a.ref.set({
          active: false,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true })));
    }
  }

  return { deactivated, peopleDeactivated };
};

const upsertPersonalMasterCached = async (personId, parsed, caches) => {
  let existing = null;
  if (parsed.legajoNormalized && caches.masterByLegajo.has(parsed.legajoNormalized)) {
    existing = caches.masterByLegajo.get(parsed.legajoNormalized);
  } else if (parsed.idNumberNormalized && caches.masterByDni.has(parsed.idNumberNormalized)) {
    existing = caches.masterByDni.get(parsed.idNumberNormalized);
  } else if (parsed.name && caches.masterByName.has(parsed.name.toLowerCase())) {
    existing = caches.masterByName.get(parsed.name.toLowerCase());
  }

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

const resolvePersonCached = async (parsed, caches) => {
  let hit = null;
  if (parsed.legajoNormalized && caches.peopleByLegajo.has(parsed.legajoNormalized)) {
    hit = caches.peopleByLegajo.get(parsed.legajoNormalized);
  } else if (parsed.idNumberNormalized && caches.peopleByDni.has(parsed.idNumberNormalized)) {
    hit = caches.peopleByDni.get(parsed.idNumberNormalized);
  }

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

const loadImportCaches = async () => {
  const [masterSnap, peopleSnap] = await Promise.all([
    db.collection('personalMaster').where('source', '==', 'nomina').get(),
    db.collection('people').limit(4000).get()
  ]);

  const masterByLegajo = new Map();
  const masterByDni = new Map();
  const masterByName = new Map();
  masterSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const row = { id: doc.id, ref: doc.ref, data };
    const legajo = String(data.legajoNormalized || data.legajo || '').trim();
    const dni = String(data.idNumberNormalized || data.idNumber || '').trim();
    const name = String(data.nameLower || data.name || '').toLowerCase().trim();
    if (legajo) masterByLegajo.set(legajo, row);
    if (dni) masterByDni.set(dni, row);
    if (name) masterByName.set(name, row);
  });

  const peopleByLegajo = new Map();
  const peopleByDni = new Map();
  peopleSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (data.active === false && data.mergedIntoId) return;
    const row = { id: doc.id, ref: doc.ref, data };
    const legajo = String(data.legajoNormalized || data.legajo || '').trim();
    const dni = String(data.dniNormalized || data.idNumberNormalized || data.idNumber || '').trim();
    if (legajo) peopleByLegajo.set(legajo, row);
    if (dni) peopleByDni.set(dni, row);
  });

  return { masterByLegajo, masterByDni, masterByName, peopleByLegajo, peopleByDni };
};

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
 * Import rápido: 1 lectura de caches + escrituras en paralelo (evita 502 por timeout Hosting 60s).
 */
const importNominaRows = async (rows = [], meta = {}) => {
  const replace = meta.replace === true;
  const stats = {
    total: rows.length,
    imported: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    deactivated: 0,
    peopleDeactivated: 0,
    errors: [],
    replace
  };

  const importRef = await db.collection('nominaImports').add({
    importedAt: FieldValue.serverTimestamp(),
    importedBy: meta.importedBy || 'admin',
    rowCount: rows.length,
    replace,
    status: 'processing'
  });

  const keepLegajos = new Set(
    (Array.isArray(meta.keepLegajos) ? meta.keepLegajos : []).map(String).filter(Boolean)
  );
  const keepDnis = new Set(
    (Array.isArray(meta.keepDnis) ? meta.keepDnis : []).map(String).filter(Boolean)
  );

  const caches = await loadImportCaches();

  const outcomes = await mapPool(rows, 10, async (row, index) => {
    const parsed = parseNominaRow(trimNominaRowPayload(row));
    if (!parsed.valid) {
      return {
        ok: false,
        skipped: true,
        error: (parsed.name || parsed.reason !== 'nombre_vacio')
          ? { row: index + 1, reason: parsed.reason, name: parsed.name || '—' }
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
        error: { row: index + 1, reason: err.message, name: parsed.name }
      };
    }
  });

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

  if (replace && (stats.imported > 0 || keepLegajos.size > 0 || keepDnis.size > 0)) {
    const wiped = await deactivateMissingNomina({
      legajos: keepLegajos,
      dnis: keepDnis
    });
    stats.deactivated = wiped.deactivated;
    stats.peopleDeactivated = wiped.peopleDeactivated;
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
  listNominaPersonal,
  listNominaBirthdays,
  upsertPersonalMaster,
  syncNominaAuthorization,
  saveNominaEmployee,
  deactivateNominaEmployee,
  deactivateMissingNomina,
  buildMasterPayload
};
