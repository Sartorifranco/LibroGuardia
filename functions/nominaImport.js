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

  // Enriquecer ficha people con campos HR (sin pisar biometría)
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
    // No desactivar si tiene huella BioStar
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

/**
 * Desactiva nómina vieja que no vino en el import.
 * NO toca people con biometricExternalId / source biostar.
 */
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

  const keepLegajos = new Set();
  const keepDnis = new Set();

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

      if (parsed.legajoNormalized) keepLegajos.add(parsed.legajoNormalized);
      if (parsed.idNumberNormalized) keepDnis.add(parsed.idNumberNormalized);

      stats.imported += 1;
      if (master.created) stats.created += 1;
      else stats.updated += 1;
    } catch (err) {
      stats.skipped += 1;
      stats.errors.push({ row: index + 1, reason: err.message, name: parsed.name });
    }
  }

  if (replace && stats.imported > 0) {
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

/** Cumpleaños de hoy / próximos N días (solo activos de nómina). */
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
      // cumpleaños ya pasó este año → próximo año solo si withinDays cruza año
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
