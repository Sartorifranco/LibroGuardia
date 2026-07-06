const { db, FieldValue } = require('./firestore');
const { normalizeIdNumber } = require('./dniParser');
const { normalizePersonName, buildNameTokens } = require('./authorizations');

const findPersonDoc = async (field, value) => {
  if (!value) return null;
  const snap = await db.collection('people')
    .where(field, '==', value)
    .where('active', '==', true)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
};

const findPersonByLegajo = (legajoNormalized) =>
  findPersonDoc('legajoNormalized', legajoNormalized);

const findPersonByNameKey = (nameKey) =>
  findPersonDoc('nameKey', nameKey);

const findPersonByDni = (dniNormalized) =>
  findPersonDoc('dniNormalized', dniNormalized);

const buildPersonPayload = ({
  name,
  legajo,
  idNumber,
  company,
  destination,
  tipo = 'empleado',
  origen = 'import'
}) => {
  const legajoNormalized = String(legajo || '').trim();
  const dniNormalized = normalizeIdNumber(idNumber);
  const nombre = String(name || '').trim();
  const nameKey = buildNameTokens(nombre);

  return {
    dni: dniNormalized || null,
    dniNormalized: dniNormalized || null,
    idNumber: dniNormalized || '',
    idNumberNormalized: dniNormalized || '',
    legajo: legajoNormalized || null,
    legajoNormalized: legajoNormalized || null,
    nombre,
    name: nombre,
    nameLower: normalizePersonName(nombre),
    nameKey,
    nameTokens: nameKey,
    tipo,
    empresa: company || null,
    company: company || '',
    destination: destination || '',
    centroCosto: null,
    origen,
    active: true,
    updatedAt: FieldValue.serverTimestamp()
  };
};

const syncPersonalMaster = async (person) => {
  const legajoNormalized = String(person.legajoNormalized || '').trim();
  const nameLower = String(person.nameLower || person.name || '').trim().toLowerCase();
  if (!legajoNormalized && !nameLower) return;

  let existing = null;
  if (legajoNormalized) {
    const snap = await db.collection('personalMaster')
      .where('legajoNormalized', '==', legajoNormalized)
      .limit(1)
      .get();
    if (!snap.empty) existing = snap.docs[0];
  }
  if (!existing && nameLower) {
    const snap = await db.collection('personalMaster')
      .where('nameLower', '==', nameLower)
      .limit(1)
      .get();
    if (!snap.empty) existing = snap.docs[0];
  }

  const payload = {
    name: person.nombre || person.name,
    nameLower,
    legajo: legajoNormalized,
    legajoNormalized,
    company: person.company || person.empresa || person.centroCosto || '',
    destination: person.destination || person.centroCosto || '',
    centroCosto: person.centroCosto || person.company || person.empresa || '',
    role: person.role || '',
    turnoRaw: person.turnoRaw || '',
    shiftSchedule: person.shiftSchedule?.valid || person.shiftSchedule?.daysOfWeek
      ? {
        daysOfWeek: person.shiftSchedule.daysOfWeek || null,
        timeWindow: person.shiftSchedule.timeWindow || null
      }
      : person.shiftSchedule || null,
    requiresCitacion: person.requiresCitacion === true,
    authorizationPolicy: person.authorizationPolicy || '',
    updatedAt: FieldValue.serverTimestamp(),
    idNumber: person.idNumber || person.dni || '',
    idNumberNormalized: person.idNumberNormalized || person.dniNormalized || '',
    personId: person.id || null,
    source: person.source || person.origen || 'sync'
  };

  if (existing) {
    await existing.ref.set(payload, { merge: true });
  } else {
    await db.collection('personalMaster').add({
      ...payload,
      createdAt: FieldValue.serverTimestamp()
    });
  }
};

const resolveOrCreatePerson = async (record, { origen = 'import', tipo = 'empleado', skipPersonalMasterSync = false } = {}) => {
  const legajoNormalized = String(record.legajoNormalized || record.legajo || '').trim();
  const nameKey = record.nameKey || buildNameTokens(record.name);
  const dniNormalized = normalizeIdNumber(record.idNumberNormalized || record.idNumber);

  let personDoc = null;
  if (legajoNormalized) {
    personDoc = await findPersonByLegajo(legajoNormalized);
  }
  if (!personDoc && nameKey) {
    personDoc = await findPersonByNameKey(nameKey);
  }
  if (!personDoc && dniNormalized) {
    personDoc = await findPersonByDni(dniNormalized);
  }

  const basePayload = buildPersonPayload({
    name: record.name,
    legajo: legajoNormalized,
    idNumber: dniNormalized,
    company: record.company,
    destination: record.destination,
    tipo,
    origen
  });

  if (personDoc) {
    const existing = personDoc.data();
    const merged = {
      ...basePayload,
      dni: dniNormalized || existing.dni || null,
      dniNormalized: dniNormalized || existing.dniNormalized || null,
      idNumber: dniNormalized || existing.idNumber || '',
      idNumberNormalized: dniNormalized || existing.idNumberNormalized || '',
      legajo: legajoNormalized || existing.legajo || null,
      legajoNormalized: legajoNormalized || existing.legajoNormalized || null,
      origen: existing.origen || origen
    };
    await personDoc.ref.set(merged, { merge: true });
    const person = { id: personDoc.id, ...merged };
    if (!skipPersonalMasterSync) {
      await syncPersonalMaster(person);
    }
    return person;
  }

  const ref = await db.collection('people').add({
    ...basePayload,
    createdAt: FieldValue.serverTimestamp()
  });
  const person = { id: ref.id, ...basePayload };
  if (!skipPersonalMasterSync) {
    await syncPersonalMaster(person);
  }
  return person;
};

const findPersonForAccess = async ({ idNumber, name }) => {
  const dniNormalized = normalizeIdNumber(idNumber);
  if (dniNormalized) {
    const byDni = await findPersonByDni(dniNormalized);
    if (byDni) return { id: byDni.id, ...byDni.data() };
  }

  const nameKey = buildNameTokens(name);
  if (nameKey) {
    const byName = await findPersonByNameKey(nameKey);
    if (byName) return { id: byName.id, ...byName.data() };
  }

  return null;
};

module.exports = {
  buildPersonPayload,
  findPersonByLegajo,
  findPersonByNameKey,
  findPersonByDni,
  findPersonForAccess,
  resolveOrCreatePerson,
  syncPersonalMaster
};
