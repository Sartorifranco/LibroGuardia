/**
 * Bandeja única de autorizaciones.
 * El guardia y el empleado solicitan; aprueba el responsable de la empresa
 * (o quien tenga alcance global). Quien pidió no puede aprobarse a sí mismo.
 */

const crypto = require('crypto');
const { db, FieldValue, Timestamp } = require('../firestore');
const { normalizeIdNumber } = require('../dniParser');
const { buildAuthorizationRecord } = require('../authorizations');
const { resolveOrCreatePerson } = require('../people');
const { triggerAccessIfAuthorized } = require('../accessControl');
const { markDirty } = require('./siteCompiler');
const { notify } = require('./notifications');
const { logAdminAction } = require('./auditLog');
const { resolvePermissions, DEFAULT_ROLE_PERMISSIONS } = require('../permissions');
const { generatePassCode } = require('./visitPassCode');
const { endOfArgentinaDay } = require('./visitasAccess');

const COLLECTION = 'accessRequests';
const TIPOS = ['visita', 'citacion', 'temporal', 'excepcion'];
const ESTADOS = ['pendiente', 'aprobada', 'rechazada', 'vencida', 'cancelada', 'revision'];
const ORIGENES = ['guardia', 'empleado', 'admin', 'importacion'];
const PAGE_MAX = 50;
const ART_OFFSET = '-03:00';

const EMERGENCY_REASONS = [
  { id: 'medico', label: 'Emergencia médica' },
  { id: 'incendio', label: 'Incendio o evacuación' },
  { id: 'seguridad', label: 'Riesgo de seguridad' },
  { id: 'autoridad', label: 'Autoridad o fuerza pública' },
  { id: 'otro', label: 'Otro' }
];

const EMERGENCY_IDS = new Set(EMERGENCY_REASONS.map((item) => item.id));

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const isGlobalApprover = (actor) => actor?.role === 'admin'
  || (Array.isArray(actor?.permissions) && actor.permissions.includes('autorizaciones.aprobar_todas'));

const isCompanyApprover = (actor) => Array.isArray(actor?.permissions)
  && actor.permissions.includes('autorizaciones.aprobar');

const samePerson = (actor, solicitadoPor) => {
  const id = String(actor?.id || '');
  const name = String(actor?.username || '');
  const who = String(solicitadoPor || '');
  if (!who) return false;
  return who === id || (name && who === name);
};

const parseInstant = (value, { endOfDay = false } = {}) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const clock = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
    const ms = Date.parse(`${raw}${clock}${ART_OFFSET}`);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
};

const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

const emergencyLabel = (id) => EMERGENCY_REASONS.find((item) => item.id === id)?.label || id;

const sentMessage = ({ empresaNombre, responsableNombre }) => {
  const who = String(responsableNombre || empresaNombre || 'supervisión').trim() || 'supervisión';
  return `Solicitud enviada a ${who}; te avisamos cuando la aprueben.`;
};

const actorFromUser = async (req) => {
  const id = req.user?.id || null;
  let profile = {};
  if (id) {
    const snap = await db.collection('users').doc(String(id)).get();
    if (snap.exists) profile = snap.data() || {};
  }
  const permissions = Array.isArray(req.userPermissions) && req.userPermissions.length
    ? req.userPermissions
    : resolvePermissions(req.user?.role || profile.role, profile.permissions || [], DEFAULT_ROLE_PERMISSIONS);
  return {
    id,
    username: req.user?.username || profile.username || id,
    role: req.user?.role || profile.role || null,
    email: profile.email || null,
    empresaId: profile.empresaId || null,
    nombre: profile.nombre || profile.username || req.user?.username || id,
    permissions: req.user?.role === 'admin'
      ? resolvePermissions('admin', [], DEFAULT_ROLE_PERMISSIONS)
      : permissions
  };
};

const origenOf = (actor) => {
  const role = String(actor?.role || '');
  if (role === 'admin') return 'admin';
  if (role.startsWith('empleado')) return 'empleado';
  if (role === 'guardia' || role === 'supervisor' || role === 'monitoreo') return 'guardia';
  return 'guardia';
};

const resolveEmpresa = async ({ empresaId, companyName }) => {
  const id = String(empresaId || '').trim();
  if (id) {
    const snap = await db.collection('empresas').doc(id).get();
    if (snap.exists) {
      const data = snap.data() || {};
      return { id: snap.id, nombre: String(data.nombre || data.name || id).trim() };
    }
  }
  const name = String(companyName || '').trim();
  if (name) {
    const snap = await db.collection('empresas').limit(PAGE_MAX).get();
    const match = snap.docs.find((doc) => {
      const data = doc.data() || {};
      const label = String(data.nombre || data.name || '').trim().toLowerCase();
      return label && label === name.toLowerCase();
    });
    if (match) {
      const data = match.data() || {};
      return { id: match.id, nombre: String(data.nombre || data.name || name).trim() };
    }
    return { id: id || null, nombre: name };
  }
  return { id: id || null, nombre: '' };
};

const resolvePuertas = async ({ destinoId, destinationName, puertas }) => {
  let doorIds = Array.isArray(puertas) ? puertas.map((id) => String(id || '').trim()).filter(Boolean) : [];
  let destinoNombre = String(destinationName || '').trim();
  let resolvedDestinoId = String(destinoId || '').trim() || null;
  if (resolvedDestinoId) {
    const snap = await db.collection('destinos').doc(resolvedDestinoId).get();
    if (!snap.exists || snap.data()?.activo === false) {
      throw httpError(400, 'Ese destino no está disponible.');
    }
    const data = snap.data() || {};
    destinoNombre = String(data.nombre || destinoNombre).trim();
    if (!doorIds.length) doorIds = (data.doorIds || []).map((id) => String(id)).filter(Boolean);
  } else if (destinoNombre && !doorIds.length) {
    const snap = await db.collection('destinos').limit(PAGE_MAX).get();
    const match = snap.docs.find((doc) => {
      const data = doc.data() || {};
      if (data.activo === false) return false;
      return String(data.nombre || '').trim().toLowerCase() === destinoNombre.toLowerCase();
    });
    if (match) {
      const data = match.data() || {};
      resolvedDestinoId = match.id;
      destinoNombre = String(data.nombre || destinoNombre).trim();
      doorIds = (data.doorIds || []).map((id) => String(id)).filter(Boolean);
    }
  }
  return { doorIds, destinoId: resolvedDestinoId, destinoNombre };
};

const userMayApprove = (userData) => {
  if (!userData || userData.active === false) return false;
  const perms = resolvePermissions(userData.role, userData.permissions || [], DEFAULT_ROLE_PERMISSIONS);
  return perms.includes('autorizaciones.aprobar') || perms.includes('autorizaciones.aprobar_todas')
    || userData.role === 'admin';
};

const responsableContacto = async (empresaId) => {
  if (!empresaId) return { emails: [], nombre: '' };
  const snap = await db.collection('users').where('empresaId', '==', empresaId).limit(PAGE_MAX).get();
  const emails = [];
  let nombre = '';
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (!userMayApprove(data)) return;
    if (!nombre) nombre = String(data.nombre || data.username || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    if (email) emails.push(email);
  });
  return { emails: [...new Set(emails)], nombre };
};

const jefeEmails = async () => {
  let snap;
  try {
    snap = await db.collection('users').where('role', 'in', ['supervisor', 'admin']).limit(PAGE_MAX).get();
  } catch {
    snap = await db.collection('users').limit(PAGE_MAX).get();
  }
  const emails = [];
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (data.active === false) return;
    const role = String(data.role || '');
    const perms = resolvePermissions(role, data.permissions || [], DEFAULT_ROLE_PERMISSIONS);
    const esJefe = role === 'admin' || role === 'supervisor' || perms.includes('autorizaciones.aprobar_todas');
    if (!esJefe) return;
    const email = String(data.email || '').trim().toLowerCase();
    if (email) emails.push(email);
  });
  return [...new Set(emails)];
};

const audit = (req, action, targetId, before, after) => {
  if (!req) return;
  logAdminAction({
    req,
    action,
    targetType: 'access_request',
    targetId,
    before,
    after
  }).catch((err) => console.error('auditLog', action, err.message));
};

const serialize = (id, data, actor) => {
  const row = { id, ...data };
  delete row.hastaMs;
  delete row.desdeMs;
  const abierta = row.estado === 'pendiente' || row.estado === 'revision';
  const propia = samePerson(actor, row.solicitadoPor);
  const global = isGlobalApprover(actor);
  const deSuEmpresa = isCompanyApprover(actor) && actor.empresaId && actor.empresaId === row.empresaId;
  row.puedeDecidir = abierta && !propia && (global || deSuEmpresa);
  row.puedeCancelar = row.estado === 'pendiente' && propia;
  return row;
};

const expireDoc = async (doc) => {
  const data = doc.data() || {};
  if (data.estado !== 'pendiente') return data;
  const hastaMs = Number(data.hastaMs) || parseInstant(data.hasta, { endOfDay: true });
  if (!hastaMs || hastaMs >= Date.now()) return data;
  await doc.ref.update({
    estado: 'vencida',
    decididoAt: new Date().toISOString()
  });
  return { ...data, estado: 'vencida' };
};

const buildRecord = async (input, actor) => {
  const tipo = String(input.tipo || 'visita').trim().toLowerCase();
  if (!TIPOS.includes(tipo)) throw httpError(400, 'Elegí si es visita, citación, temporal o excepción.');
  const name = String(input.persona?.name || input.name || '').trim();
  const dni = normalizeIdNumber(input.persona?.dni || input.dni || input.idNumber || '');
  if (!name) throw httpError(400, 'El nombre es obligatorio.');
  if (!dni) throw httpError(400, 'El DNI es obligatorio.');
  const motivo = String(input.motivo || input.notes || '').trim();
  if (motivo.length < 3) throw httpError(400, 'Escribí un motivo corto.');
  const desdeMs = parseInstant(input.desde || input.startDate, { endOfDay: false });
  const hastaMs = parseInstant(input.hasta || input.endDate || input.desde || input.startDate, { endOfDay: true });
  if (!desdeMs || !hastaMs) throw httpError(400, 'Indicá desde y hasta cuándo.');
  if (hastaMs < desdeMs) throw httpError(400, 'La fecha de fin no puede ser anterior al inicio.');
  const empresa = await resolveEmpresa({
    empresaId: input.empresaId || input.persona?.empresaId,
    companyName: input.company || input.companyName || input.empresaNombre
  });
  const puertas = await resolvePuertas({
    destinoId: input.destinoId,
    destinationName: input.destination || input.destinoNombre,
    puertas: input.puertas || input.allowedDoorIds
  });
  const origen = ORIGENES.includes(input.origen) ? input.origen : origenOf(actor);
  const contacto = await responsableContacto(empresa.id);
  return {
    tipo,
    persona: {
      name,
      dni,
      empresaId: empresa.id || null,
      personId: input.persona?.personId || null
    },
    empresaId: empresa.id || null,
    empresaNombre: empresa.nombre || '',
    destinoId: puertas.destinoId,
    destinoNombre: puertas.destinoNombre || '',
    puertas: puertas.doorIds,
    desde: toIso(desdeMs),
    hasta: toIso(hastaMs),
    desdeMs,
    hastaMs,
    motivo,
    estado: 'pendiente',
    solicitadoPor: actor?.id || null,
    solicitadoPorNombre: actor?.nombre || actor?.username || null,
    solicitadoPorEmail: actor?.email || null,
    aprobadoPor: null,
    decididoAt: null,
    notaDecision: '',
    origen,
    responsableNombre: contacto.nombre || '',
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    _notifyEmails: contacto.emails
  };
};

const createAccessRequest = async (input, actor, { req, requireDoors = false } = {}) => {
  const draft = await buildRecord(input, actor);
  if (requireDoors && !draft.puertas.length && !draft.destinoId && !draft.destinoNombre) {
    throw httpError(400, 'Elegí un destino o al menos una puerta.');
  }
  const notifyEmails = draft._notifyEmails || [];
  delete draft._notifyEmails;
  const ref = await db.collection(COLLECTION).add(draft);
  const message = sentMessage({
    empresaNombre: draft.empresaNombre,
    responsableNombre: draft.responsableNombre
  });
  audit(req, 'access_request.create', ref.id, null, {
    tipo: draft.tipo,
    estado: draft.estado,
    empresaId: draft.empresaId,
    persona: draft.persona?.name
  });
  await notify('access_request', {
    phase: 'nueva',
    name: draft.persona.name,
    dni: draft.persona.dni,
    empresaNombre: draft.empresaNombre || 'supervisión',
    motivo: draft.motivo,
    desde: draft.desde,
    hasta: draft.hasta,
    solicitadoPorNombre: draft.solicitadoPorNombre,
    extraRecipients: notifyEmails
  });
  return {
    id: ref.id,
    ...draft,
    message
  };
};

const matchesVista = (row, estado) => {
  const key = String(estado || '').trim().toLowerCase();
  if (!key) return true;
  if (key === 'abiertas') return row.estado === 'pendiente' || row.estado === 'revision';
  if (key === 'vigentes') {
    if (row.estado !== 'aprobada') return false;
    const hasta = Number(row.hastaMs) || parseInstant(row.hasta, { endOfDay: true });
    return !hasta || hasta >= Date.now();
  }
  if (key === 'historial') {
    if (['rechazada', 'vencida', 'cancelada'].includes(row.estado)) return true;
    if (row.estado !== 'aprobada') return false;
    const hasta = Number(row.hastaMs) || parseInstant(row.hasta, { endOfDay: true });
    return Boolean(hasta && hasta < Date.now());
  }
  return row.estado === key;
};

const inScope = (row, actor, empresaIdFilter) => {
  if (empresaIdFilter && row.empresaId !== empresaIdFilter) return false;
  if (isGlobalApprover(actor)) return true;
  const own = samePerson(actor, row.solicitadoPor);
  const company = isCompanyApprover(actor) && actor.empresaId && row.empresaId === actor.empresaId;
  return own || company;
};

const listAccessRequests = async (actor, { estado, empresaId, limit } = {}) => {
  const cap = Math.min(PAGE_MAX, Math.max(1, Number(limit) || PAGE_MAX));
  const filterEmpresa = String(empresaId || '').trim();
  if (filterEmpresa && !isGlobalApprover(actor) && filterEmpresa !== actor.empresaId) {
    throw httpError(403, 'Solo podés ver las solicitudes de tu empresa.');
  }
  const snaps = [];
  const col = db.collection(COLLECTION);
  if (isGlobalApprover(actor)) {
    let q = col;
    if (filterEmpresa) q = q.where('empresaId', '==', filterEmpresa);
    snaps.push(await q.limit(cap).get());
  } else {
    if (isCompanyApprover(actor) && actor.empresaId) {
      snaps.push(await col.where('empresaId', '==', actor.empresaId).limit(cap).get());
    }
    if (actor.id) {
      snaps.push(await col.where('solicitadoPor', '==', actor.id).limit(cap).get());
    }
  }
  const byId = new Map();
  snaps.forEach((snap) => snap.docs.forEach((doc) => byId.set(doc.id, doc)));
  const rows = [];
  for (const doc of byId.values()) {
    const data = await expireDoc(doc);
    rows.push({ id: doc.id, ...data });
  }
  rows.sort((a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0));
  const pendingCount = rows.filter((row) => row.estado === 'pendiente' || row.estado === 'revision').length;
  const requests = rows
    .filter((row) => inScope(row, actor, filterEmpresa))
    .filter((row) => matchesVista(row, estado))
    .slice(0, cap)
    .map((row) => serialize(row.id, row, actor));
  return { requests, pendingCount, limit: cap };
};

const loadRequest = async (id) => {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'No encontramos esa solicitud.');
  const data = await expireDoc(snap);
  return { ref, data: { id: snap.id, ...data } };
};

const assertCanDecide = (actor, data) => {
  if (samePerson(actor, data.solicitadoPor)) {
    throw httpError(403, 'No podés decidir una solicitud que pediste vos.');
  }
  if (isGlobalApprover(actor)) return;
  if (isCompanyApprover(actor) && actor.empresaId && data.empresaId === actor.empresaId) return;
  throw httpError(403, 'Esta solicitud no es de tu empresa.');
};

const notifyDecision = async (data, estado) => {
  const to = [];
  if (data.solicitadoPorEmail) to.push(data.solicitadoPorEmail);
  await notify('access_request', {
    phase: 'decidida',
    name: data.persona?.name,
    dni: data.persona?.dni,
    empresaNombre: data.empresaNombre,
    estado,
    nota: data.notaDecision || '',
    extraRecipients: to
  });
};

const grantOnApprove = async (data) => {
  const persona = data.persona || {};
  const person = await resolveOrCreatePerson({
    name: persona.name,
    idNumber: persona.dni,
    company: data.empresaNombre,
    destination: data.destinoNombre
  }, {
    origen: 'access_request',
    tipo: data.tipo === 'visita' ? 'visita' : 'empleado',
    skipPersonalMasterSync: true
  });

  if (data.tipo === 'visita') {
    const ref = db.collection('visitas').doc();
    const expected = new Date(data.desde);
    await ref.set({
      nombreVisitante: persona.name,
      dniVisitante: persona.dni,
      dniVisitanteNormalized: persona.dni,
      fechaHoraEsperada: Timestamp.fromDate(expected),
      motivo: data.motivo || '',
      destinoId: data.destinoId || null,
      destinoNombre: data.destinoNombre || '',
      allowedDoorIds: data.puertas || [],
      empresaId: data.empresaId || null,
      empresaNombre: data.empresaNombre || '',
      estado: 'autorizada',
      inviteToken: crypto.randomBytes(24).toString('hex'),
      inviteExpiresAt: Timestamp.fromDate(endOfArgentinaDay(expected)),
      passCode: generatePassCode(),
      qrId: ref.id,
      personId: person.id,
      accessRequestId: data.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    await markDirty({ visitas: [ref.id], people: person.id ? [person.id] : [] });
    return { kind: 'visita', id: ref.id, personId: person.id };
  }

  const startDate = String(data.desde || '').slice(0, 10);
  const endDate = String(data.hasta || '').slice(0, 10);
  const authType = data.tipo === 'citacion' ? 'citacion' : 'temporal';
  const record = buildAuthorizationRecord({
    type: authType,
    name: persona.name,
    idNumber: persona.dni,
    company: data.empresaNombre,
    destination: data.destinoNombre,
    startDate,
    endDate,
    notes: data.motivo,
    personId: person.id,
    source: 'access_request',
    active: true
  });
  const ref = await db.collection('authorizations').add({
    ...record,
    allowedDoorIds: data.puertas || [],
    accessRequestId: data.id,
    createdAt: FieldValue.serverTimestamp()
  });
  await markDirty({ auths: [ref.id], people: person.id ? [person.id] : [] });
  return { kind: 'authorization', id: ref.id, personId: person.id };
};

const approveAccessRequest = async (id, actor, { nota, req } = {}) => {
  const { ref, data } = await loadRequest(id);
  if (data.estado === 'vencida') throw httpError(400, 'Esta solicitud se venció.');
  if (data.estado !== 'pendiente' && data.estado !== 'revision') {
    throw httpError(400, 'Esta solicitud ya fue decidida.');
  }
  assertCanDecide(actor, data);
  const notaDecision = String(nota || '').trim();
  let grant = null;
  if (data.estado === 'pendiente') {
    grant = await grantOnApprove(data);
  }
  const persona = {
    ...(data.persona || {}),
    personId: grant?.personId || data.persona?.personId || null
  };
  const patch = {
    estado: 'aprobada',
    aprobadoPor: actor.id,
    aprobadoPorNombre: actor.nombre || actor.username,
    decididoAt: new Date().toISOString(),
    notaDecision,
    grantKind: grant?.kind || null,
    grantId: grant?.id || null,
    persona
  };
  await ref.update(patch);
  audit(req, 'access_request.approve', id, { estado: data.estado }, {
    estado: 'aprobada',
    grantKind: grant?.kind || null,
    grantId: grant?.id || null
  });
  await notifyDecision({ ...data, notaDecision }, 'aprobada');
  return serialize(id, { ...data, ...patch }, actor);
};

const rejectAccessRequest = async (id, actor, { nota, req } = {}) => {
  const notaDecision = String(nota || '').trim();
  if (notaDecision.length < 3) throw httpError(400, 'Para rechazar tenés que escribir el motivo.');
  const { ref, data } = await loadRequest(id);
  if (data.estado !== 'pendiente' && data.estado !== 'revision') {
    throw httpError(400, 'Esta solicitud ya fue decidida.');
  }
  assertCanDecide(actor, data);
  const patch = {
    estado: 'rechazada',
    aprobadoPor: actor.id,
    aprobadoPorNombre: actor.nombre || actor.username,
    decididoAt: new Date().toISOString(),
    notaDecision
  };
  await ref.update(patch);
  audit(req, 'access_request.reject', id, { estado: data.estado }, { estado: 'rechazada', notaDecision });
  await notifyDecision({ ...data, notaDecision }, 'rechazada');
  return serialize(id, { ...data, ...patch }, actor);
};

const cancelAccessRequest = async (id, actor, { req } = {}) => {
  const { ref, data } = await loadRequest(id);
  if (!samePerson(actor, data.solicitadoPor)) {
    throw httpError(403, 'Solo quien la pidió puede cancelarla.');
  }
  if (data.estado !== 'pendiente') throw httpError(400, 'Solo se puede cancelar una solicitud pendiente.');
  const patch = {
    estado: 'cancelada',
    decididoAt: new Date().toISOString(),
    notaDecision: 'Cancelada por quien la pidió'
  };
  await ref.update(patch);
  audit(req, 'access_request.cancel', id, { estado: 'pendiente' }, { estado: 'cancelada' });
  return serialize(id, { ...data, ...patch }, actor);
};

const recordEmergencyReview = async ({
  entryId,
  name,
  dni,
  reasonCode,
  reasonText,
  company,
  destination,
  empresaId,
  doorId,
  actor,
  req
}) => {
  const label = emergencyLabel(reasonCode);
  const fullReason = `${label}: ${reasonText}`;
  const ahora = Date.now();
  const finDia = parseInstant(new Date().toISOString().slice(0, 10), { endOfDay: true });
  const empresa = await resolveEmpresa({ empresaId, companyName: company });
  const requestRef = await db.collection(COLLECTION).add({
    tipo: 'excepcion',
    persona: { name, dni: dni || '', empresaId: empresa.id, personId: null },
    empresaId: empresa.id,
    empresaNombre: empresa.nombre || company || '',
    destinoId: null,
    destinoNombre: destination || '',
    puertas: doorId ? [String(doorId)] : [],
    desde: toIso(ahora),
    hasta: toIso(finDia),
    desdeMs: ahora,
    hastaMs: finDia,
    motivo: fullReason,
    estado: 'revision',
    solicitadoPor: actor?.id || null,
    solicitadoPorNombre: actor?.nombre || actor?.username || null,
    solicitadoPorEmail: actor?.email || null,
    aprobadoPor: null,
    decididoAt: null,
    notaDecision: '',
    origen: origenOf(actor),
    entryId: entryId || null,
    emergencyReason: reasonCode,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now()
  });

  const alarmId = await writeEmergencyAlarm({
    entryId: entryId || requestRef.id,
    name,
    dni,
    reasonLabel: label,
    detail: reasonText,
    username: actor?.username || actor?.id,
    doorId: doorId || null
  });

  const emails = await jefeEmails();
  await notify('ingreso_emergencia', {
    name,
    idNumber: dni,
    reason: fullReason,
    username: actor?.username || actor?.id,
    entryId: entryId || null,
    extraRecipients: emails
  });

  audit(req, 'access_request.emergency', requestRef.id, null, {
    estado: 'revision',
    entryId: entryId || null,
    alarmId,
    motivo: fullReason
  });

  return {
    requestId: requestRef.id,
    alarmId,
    alarmType: 'ingreso_emergencia',
    message: 'Puerta abierta por emergencia. Avisamos al jefe de seguridad; después lo tiene que revisar.'
  };
};

const writeEmergencyAlarm = async ({ entryId, name, dni, reasonLabel, detail, username, doorId }) => {
  const siteId = String(process.env.SITE_ID || 'principal');
  const alarmId = `ingreso_emergencia_${entryId}`;
  const message = `${name || 'Persona'}${dni ? ` (${dni})` : ''}: ${reasonLabel}. ${detail}`.slice(0, 300);
  await db.collection('sites').doc(siteId).collection('alarms').doc(alarmId).set({
    siteId,
    type: 'ingreso_emergencia',
    state: 'active',
    critical: true,
    doorId: doorId || null,
    message,
    entryId,
    username: username || null,
    firstTs: Date.now(),
    lastTs: Date.now(),
    count: 1,
    updatedAt: FieldValue.serverTimestamp()
  });
  return alarmId;
};

const openEmergency = async (payload, actor, { req } = {}) => {
  const reasonCode = String(payload.reasonCode || payload.emergencyReason || '').trim();
  const reasonText = String(payload.reasonText || payload.reasonDetail || payload.reason || '').trim();
  if (!EMERGENCY_IDS.has(reasonCode)) {
    throw httpError(400, 'Elegí el tipo de emergencia de la lista.');
  }
  if (reasonText.length < 5 || reasonText === reasonCode) {
    throw httpError(400, 'Escribí qué pasó (unas palabras). Esto le queda al jefe.');
  }
  const name = String(payload.name || payload.persona?.name || '').trim();
  const idNumber = normalizeIdNumber(payload.idNumber || payload.dni || payload.persona?.dni || '');
  if (!name) throw httpError(400, 'El nombre es obligatorio.');

  const label = emergencyLabel(reasonCode);
  const fullReason = `${label}: ${reasonText}`;
  const entryRef = await db.collection('entries').add({
    type: 'personal',
    movementType: payload.movementType || 'ingreso',
    name,
    idNumber: idNumber || '',
    company: payload.company || '',
    destination: payload.destination || '',
    entrySource: 'manual',
    eventTime: payload.eventTime || null,
    registeredBy: actor?.id || null,
    timestamp: FieldValue.serverTimestamp(),
    exceptionalEntry: true,
    emergency: true,
    alarmType: 'ingreso_emergencia',
    exceptionalReason: fullReason,
    accessAuthorized: true,
    accessReason: 'ingreso_excepcional',
    authorizationType: 'ingreso_excepcional',
    notes: `Emergencia: ${fullReason}`
  });

  const accessResult = await triggerAccessIfAuthorized({
    movementType: payload.movementType || 'ingreso',
    idNumber,
    name,
    entrySource: 'manual',
    entryId: entryRef.id,
    username: actor?.username || actor?.id,
    allowManualOverride: true,
    doorId: payload.doorId || null
  });

  await entryRef.update({
    accessAuthorized: true,
    relayTriggered: Boolean(accessResult.relay?.triggered),
    relayError: accessResult.relay?.error || null
  });

  const review = await recordEmergencyReview({
    entryId: entryRef.id,
    name,
    dni: idNumber,
    reasonCode,
    reasonText,
    company: payload.company,
    destination: payload.destination,
    empresaId: payload.empresaId,
    doorId: payload.doorId || null,
    actor,
    req
  });

  return {
    entryId: entryRef.id,
    access: accessResult,
    ...review
  };
};

const createPendingFromEntry = async (body, actor, { req } = {}) => {
  const created = await createAccessRequest({
    tipo: 'temporal',
    name: body.name,
    idNumber: body.idNumber,
    company: body.company,
    destination: body.destination,
    empresaId: body.empresaId,
    destinoId: body.destinoId,
    puertas: body.puertas || body.allowedDoorIds,
    desde: body.desde || new Date().toISOString(),
    hasta: body.hasta || new Date().toISOString().slice(0, 10),
    motivo: body.motivo || body.exceptionalReason || 'Pedido de autorización desde guardia',
    origen: origenOf(actor)
  }, actor, { req, requireDoors: false });
  return created;
};

const listOptions = async () => {
  const [empresasSnap, destinosSnap] = await Promise.all([
    db.collection('empresas').limit(PAGE_MAX).get(),
    db.collection('destinos').limit(PAGE_MAX).get()
  ]);
  let doors = [];
  try {
    const { getDoorsConfig } = require('./doorsConfig');
    const config = await getDoorsConfig();
    doors = (config.doors || [])
      .filter((door) => door && door.active !== false)
      .slice(0, PAGE_MAX)
      .map((door) => ({ id: door.id, name: door.name || door.id }));
  } catch {
    doors = [];
  }
  return {
    empresas: empresasSnap.docs.map((doc) => {
      const data = doc.data() || {};
      return { id: doc.id, nombre: data.nombre || data.name || doc.id };
    }),
    destinos: destinosSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((row) => row.activo !== false)
      .map((row) => ({ id: row.id, nombre: row.nombre || row.id, doorIds: row.doorIds || [] })),
    puertas: doors,
    emergencyReasons: EMERGENCY_REASONS
  };
};

module.exports = {
  COLLECTION,
  TIPOS,
  ESTADOS,
  EMERGENCY_REASONS,
  sentMessage,
  actorFromUser,
  createAccessRequest,
  listAccessRequests,
  approveAccessRequest,
  rejectAccessRequest,
  cancelAccessRequest,
  openEmergency,
  recordEmergencyReview,
  createPendingFromEntry,
  listOptions,
  parseInstant,
  isGlobalApprover
};
