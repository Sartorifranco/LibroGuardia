const { decidirAcceso } = require('./accessControl');
const { normalizeIdNumber } = require('./dniParser');
const { createAccessRequest, openEmergency } = require('./lib/accessRequests');

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
  const tipoRaw = String(payload.type || 'visita').toLowerCase();
  const tipo = tipoRaw === 'citacion' || tipoRaw === 'temporal' ? tipoRaw : 'visita';
  const hoy = new Date().toISOString().slice(0, 10);
  const created = await createAccessRequest({
    tipo,
    name: payload.name,
    idNumber: payload.idNumber || payload.legajo,
    company: payload.company,
    empresaId: payload.empresaId,
    destination: payload.destination,
    destinoId: payload.destinoId,
    puertas: payload.puertas || payload.allowedDoorIds,
    desde: payload.startDate || hoy,
    hasta: payload.endDate || payload.startDate || hoy,
    motivo: payload.notes || `Pre-registro de guardia (${meta.username || 'guardia'})`,
    origen: 'guardia'
  }, {
    id: meta.userId || null,
    username: meta.username || meta.userId || 'guardia',
    nombre: meta.username || meta.userId || 'guardia',
    role: 'guardia',
    email: meta.email || null
  }, { req: meta.req, requireDoors: false });

  return {
    id: created.id,
    request: created,
    pending: true,
    message: created.message
  };
};

const registerExceptionalEntry = async (payload = {}, meta = {}) => openEmergency(payload, {
  id: meta.userId || null,
  username: meta.username || meta.userId || null,
  nombre: meta.username || meta.userId || null,
  email: meta.email || null,
  role: meta.role || 'guardia'
}, { req: meta.req });

module.exports = {
  checkAccessStatus,
  preRegisterVisitor,
  registerExceptionalEntry,
  splitFullName
};
