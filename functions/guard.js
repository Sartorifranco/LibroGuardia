const { db, FieldValue } = require('./firestore');
const { buildAuthorizationRecord, todayDateString } = require('./authorizations');
const { resolveOrCreatePerson } = require('./people');
const { decidirAcceso, triggerAccessIfAuthorized } = require('./accessControl');
const { normalizeIdNumber } = require('./dniParser');

const splitFullName = (fullName = '') => {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { apellido: parts[0] || '', nombre: '' };
  return { apellido: parts[0], nombre: parts.slice(1).join(' ') };
};

const checkAccessStatus = async ({ dni = '', name = '' }) => {
  const { apellido, nombre } = splitFullName(name);
  const decision = await decidirAcceso({
    dni: dni || normalizeIdNumber(name),
    nombre,
    apellido,
    tipoMovimiento: 'ingreso'
  });

  return {
    authorized: decision.authorized,
    denialReason: decision.denialReason,
    personId: decision.personId,
    personName: decision.personName,
    authorizationType: decision.authorizationType
  };
};

const preRegisterVisitor = async (payload = {}, meta = {}) => {
  const startDate = payload.startDate || todayDateString();
  const endDate = payload.endDate || startDate;
  const data = buildAuthorizationRecord({
    type: payload.type || 'visita',
    name: payload.name,
    idNumber: payload.idNumber,
    legajo: payload.legajo,
    company: payload.company,
    destination: payload.destination,
    startDate,
    endDate,
    notes: payload.notes || `Pre-registro guardia: ${meta.username || 'guardia'}`,
    source: 'guard_preregister'
  });

  const person = await resolveOrCreatePerson(data, {
    origen: 'guard_preregister',
    tipo: payload.personTipo || 'visita'
  });

  const ref = await db.collection('authorizations').add({
    ...data,
    personId: person.id,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: meta.username || meta.userId || 'guardia',
    preregisteredBy: meta.username || meta.userId || null
  });

  return { id: ref.id, ...data, personId: person.id };
};

const registerExceptionalEntry = async ({
  name,
  idNumber,
  company,
  destination,
  eventTime,
  reason,
  movementType = 'ingreso'
}, meta = {}) => {
  if (!String(reason || '').trim()) {
    const error = new Error('Indique el motivo del ingreso excepcional');
    error.status = 400;
    throw error;
  }
  if (!String(name || '').trim()) {
    const error = new Error('El nombre es obligatorio');
    error.status = 400;
    throw error;
  }

  const entryRef = await db.collection('entries').add({
    type: 'personal',
    movementType,
    name: name.trim(),
    idNumber: idNumber || '',
    company: company || '',
    destination: destination || '',
    entrySource: 'manual',
    eventTime: eventTime || null,
    registeredBy: meta.userId,
    timestamp: FieldValue.serverTimestamp(),
    exceptionalEntry: true,
    exceptionalReason: reason.trim(),
    accessAuthorized: true,
    accessReason: 'ingreso_excepcional',
    authorizationType: 'ingreso_excepcional',
    notes: `Ingreso excepcional: ${reason.trim()}`
  });

  const accessResult = await triggerAccessIfAuthorized({
    movementType,
    idNumber,
    name,
    entrySource: 'manual',
    entryId: entryRef.id,
    username: meta.userId,
    allowManualOverride: true
  });

  await entryRef.update({
    accessAuthorized: true,
    accessReason: 'ingreso_excepcional',
    authorizationType: 'ingreso_excepcional',
    relayTriggered: Boolean(accessResult.relay?.triggered),
    relayError: accessResult.relay?.error || null
  });

  return {
    entryId: entryRef.id,
    access: accessResult,
    message: 'Ingreso excepcional registrado'
  };
};

module.exports = {
  checkAccessStatus,
  preRegisterVisitor,
  registerExceptionalEntry,
  splitFullName
};
