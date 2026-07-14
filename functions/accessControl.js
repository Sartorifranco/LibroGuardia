const { db, FieldValue, Timestamp } = require('./firestore');
const { normalizeIdNumber, parseScanData } = require('./dniParser');
const { triggerRelay } = require('./sr201');
const { resolveAuthorizationForAccess, getAuthorizationLabel } = require('./authorizations');
const {
  DEFAULT_ACCESS_CONTROL,
  getAccessControlConfig,
  logAccessEvent
} = require('./lib/accessControlStore');
const {
  buildNameKey,
  buildFullName,
  getArgentinaDateParts,
  normalizeDni
} = require('./lib/normalize');
const {
  TOLERANCIA_MINUTOS,
  evaluateAuthorizationCandidates
} = require('./lib/accessValidation');
const { buildNominaAccessMessage } = require('./lib/accessNominaMessages');

const findPersonalMaster = async (idNumber) => {
  const idNumberNormalized = normalizeIdNumber(idNumber);
  if (!idNumberNormalized) return null;

  const snap = await db.collection('personalMaster')
    .where('idNumberNormalized', '==', idNumberNormalized)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
};

const resolvePersonForValidarAcceso = async ({ dni, nombre, apellido }) => {
  const dniNormalized = normalizeDni(dni);
  const nameKey = buildNameKey(nombre, apellido);
  const fullName = buildFullName(nombre, apellido);

  let resolutionPath = 'no_encontrado';
  let personDoc = null;

  if (dniNormalized) {
    const snap = await db.collection('people')
      .where('dniNormalized', '==', dniNormalized)
      .limit(1)
      .get();
    if (!snap.empty) {
      personDoc = snap.docs[0];
      resolutionPath = 'dni';
    }
  }

  if (!personDoc && nameKey) {
    const snap = await db.collection('people')
      .where('nameKey', '==', nameKey)
      .limit(1)
      .get();
    if (!snap.empty) {
      personDoc = snap.docs[0];
      resolutionPath = 'nameKey';

      const data = personDoc.data();
      if (dniNormalized && !data.dniNormalized) {
        await personDoc.ref.update({
          dni: dniNormalized,
          dniNormalized,
          idNumber: dniNormalized,
          idNumberNormalized: dniNormalized,
          updatedAt: FieldValue.serverTimestamp()
        });
        console.log('[accessControl] DNI completado en people por nameKey', {
          personId: personDoc.id,
          dniNormalized
        });
      }
    }
  }

  console.log('[accessControl] Resolución de persona', {
    resolutionPath,
    dniNormalized: dniNormalized || null,
    nameKey: nameKey || null
  });

  if (!personDoc) {
    return {
      person: null,
      personId: null,
      resolutionPath,
      nameSnapshot: fullName,
      dniNormalized: dniNormalized || null
    };
  }

  const person = { id: personDoc.id, ...personDoc.data() };
  if (personDoc.ref && dniNormalized && !person.dniNormalized) {
    person.dniNormalized = dniNormalized;
    person.dni = dniNormalized;
  }

  return {
    person,
    personId: personDoc.id,
    resolutionPath,
    nameSnapshot: person.nombre || person.name || fullName,
    dniNormalized: dniNormalized || person.dniNormalized || null
  };
};

const mapAuthorizationDocs = (snap) =>
  snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

const fetchPrimaryAuthorizations = async (personId, today) => {
  const col = db.collection('authorizations');
  const [permanentSnap, citacionSnap] = await Promise.all([
    col
      .where('personId', '==', personId)
      .where('active', '==', true)
      .where('type', '==', 'permanent')
      .get(),
    col
      .where('personId', '==', personId)
      .where('active', '==', true)
      .where('type', '==', 'citacion')
      .where('appointmentDate', '==', today)
      .get()
  ]);

  return {
    permanentDocs: mapAuthorizationDocs(permanentSnap),
    citacionDocs: mapAuthorizationDocs(citacionSnap)
  };
};

const fetchRangeAuthorizations = async (personId, today) => {
  // TODO: authorizations.js legacy usa type "visit"; el modelo nuevo dice "visita".
  // Se aceptan ambos hasta unificar el backfill/migración.
  const snap = await db.collection('authorizations')
    .where('personId', '==', personId)
    .where('active', '==', true)
    .where('type', 'in', ['visita', 'visit', 'temporal'])
    .where('startDate', '<=', today)
    .get();

  return mapAuthorizationDocs(snap).filter((auth) => {
    const endDate = auth.endDate || auth.startDate;
    return endDate && today <= endDate;
  });
};

const fetchAuthorizationsForPerson = async (personId, today) => {
  const { permanentDocs, citacionDocs } = await fetchPrimaryAuthorizations(personId, today);
  return { permanentDocs, citacionDocs, rangeDocs: [] };
};

const writeAccessEntry = async ({
  personId,
  authorizationId,
  nameSnapshot,
  dniSnapshot,
  tipoMovimiento,
  channel,
  authorized,
  denialReason,
  guardId,
  authorizationType = null,
  registeredBy = null
}) => {
  const payload = {
    personId: personId || null,
    authorizationId: authorizationId || null,
    nameSnapshot: nameSnapshot || '',
    dniSnapshot: dniSnapshot || null,
    tipoMovimiento,
    channel,
    authorized: Boolean(authorized),
    denialReason: denialReason || null,
    guardId: guardId || null,
    timestamp: FieldValue.serverTimestamp(),
    notes: null,
    type: 'personal',
    movementType: tipoMovimiento,
    name: nameSnapshot || '',
    idNumber: dniSnapshot || '',
    entrySource: channel === 'molinete' ? 'kiosk' : 'manual',
    accessAuthorized: Boolean(authorized),
    accessReason: denialReason || authorizationType,
    authorizationType: authorizationType || null,
    registeredBy: registeredBy || guardId || null,
    eventTime: getArgentinaDateParts().timeString
  };

  const entryRef = await db.collection('entries').add(payload);
  return entryRef.id;
};

const decidirAcceso = async ({
  dni = '',
  nombre = '',
  apellido = '',
  tipoMovimiento = 'ingreso',
  referenceDate = new Date()
}) => {
  const { dateString: today, dayCode } = getArgentinaDateParts(referenceDate);
  const dniNormalized = normalizeDni(dni);
  const nameSnapshot = buildFullName(nombre, apellido);

  if (tipoMovimiento === 'egreso') {
    const resolved = await resolvePersonForValidarAcceso({ dni, nombre, apellido });
    return {
      authorized: true,
      denialReason: null,
      personId: resolved.personId,
      personName: resolved.nameSnapshot || nameSnapshot,
      authorization: null,
      authorizationType: null,
      dniNormalized: dniNormalized || resolved.dniNormalized
    };
  }

  const resolved = await resolvePersonForValidarAcceso({ dni, nombre, apellido });
  let authorization = null;
  let authorizationType = null;
  let authorized = false;
  let denialReason = null;

  if (!resolved.personId) {
    denialReason = 'no_encontrado';
    console.log('[accessControl] Acceso denegado: persona no encontrada');
  } else if (resolved.person?.active === false) {
    denialReason = 'persona_inactiva';
    console.log('[accessControl] Acceso denegado: persona inactiva', { personId: resolved.personId });
  } else {
    const { permanentDocs, citacionDocs } = await fetchPrimaryAuthorizations(resolved.personId, today);
    let evaluation = evaluateAuthorizationCandidates({
      permanentDocs,
      citacionDocs,
      rangeDocs: [],
      today,
      dayCode,
      referenceDate
    });

    if (!evaluation.authorization) {
      const rangeDocs = await fetchRangeAuthorizations(resolved.personId, today);
      evaluation = evaluateAuthorizationCandidates({
        permanentDocs: [],
        citacionDocs: [],
        rangeDocs,
        today,
        dayCode,
        referenceDate
      });
    }

    authorization = evaluation.authorization;
    denialReason = evaluation.denialReason;

    if (!authorization) {
      console.log('[accessControl] Sin autorización por personId, probando fallback legacy');
      authorization = await resolveAuthorizationForAccess({
        idNumber: dniNormalized,
        name: resolved.nameSnapshot,
        referenceDate: today,
        person: resolved.person
      });
    }

    if (authorization) {
      authorized = true;
      authorizationType = authorization.type;
      denialReason = null;
      console.log('[accessControl] Acceso autorizado', {
        personId: resolved.personId,
        authorizationType,
        authorizationId: authorization.id
      });
    } else if (!denialReason) {
      denialReason = 'sin_citacion_para_hoy';
      console.log('[accessControl] Acceso denegado: sin autorización vigente hoy', {
        personId: resolved.personId
      });
    }
  }

  return {
    authorized,
    denialReason,
    personId: resolved.personId,
    personName: resolved.nameSnapshot || nameSnapshot,
    authorization,
    authorizationType,
    dniNormalized
  };
};

const validarAcceso = async ({
  dni = '',
  nombre = '',
  apellido = '',
  tipoMovimiento = 'ingreso',
  channel = 'molinete',
  guardId = null
}) => {
  const dniNormalized = normalizeDni(dni);
  const nameSnapshot = buildFullName(nombre, apellido);

  let decision;
  try {
    decision = await decidirAcceso({ dni, nombre, apellido, tipoMovimiento });
  } catch (err) {
    console.error('[accessControl] Error interno en validarAcceso', err);
    decision = {
      authorized: false,
      denialReason: 'error_interno',
      personId: null,
      personName: nameSnapshot,
      authorization: null,
      authorizationType: null,
      dniNormalized
    };
  }

  const entryId = await writeAccessEntry({
    personId: decision.personId,
    authorizationId: decision.authorization?.id || null,
    nameSnapshot: decision.personName,
    dniSnapshot: decision.dniNormalized || dniNormalized,
    tipoMovimiento,
    channel,
    authorized: decision.authorized,
    denialReason: decision.denialReason,
    guardId,
    authorizationType: decision.authorizationType,
    registeredBy: guardId
  });

  return {
    authorized: decision.authorized,
    denialReason: decision.denialReason,
    personId: decision.personId,
    personName: decision.personName,
    authorizationType: decision.authorizationType,
    entryId
  };
};

const evaluatePersonalAccess = async ({
  movementType = 'ingreso',
  idNumber,
  name = '',
  firstName = '',
  lastName = '',
  entrySource = 'manual',
  allowManualOverride = null,
  guardId = null,
  referenceDate = getArgentinaDateParts().dateString
}) => {
  const config = await getAccessControlConfig();

  if (movementType !== 'ingreso') {
    return {
      authorized: true,
      reason: 'egreso',
      authorization: null,
      authorizationType: null,
      authorizationLabel: 'Egreso',
      master: null,
      displayName: name,
      message: 'Egreso registrado',
      config
    };
  }

  if (entrySource === 'manual' && (allowManualOverride ?? config.allowManualOverride)) {
    return {
      authorized: true,
      reason: allowManualOverride === true ? 'ingreso_excepcional' : 'manual_override',
      authorization: null,
      authorizationType: allowManualOverride === true ? 'ingreso_excepcional' : 'manual_override',
      authorizationLabel: allowManualOverride === true ? 'Ingreso excepcional' : 'Autorización manual',
      master: null,
      displayName: name,
      message: `Autorización manual${name ? `: ${name}` : ''}`,
      config
    };
  }

  const parsedName = name || buildFullName(firstName, lastName);
  const nameParts = parsedName.split(/\s+/).filter(Boolean);
  const apellido = lastName || nameParts[0] || '';
  const nombreParsed = firstName || nameParts.slice(1).join(' ') || parsedName;

  const decision = await decidirAcceso({
    dni: idNumber,
    nombre: nombreParsed,
    apellido,
    tipoMovimiento: movementType,
    referenceDate: new Date(`${referenceDate}T12:00:00`)
  });

  const result = decision;

  const master = result.personId
    ? { id: result.personId, personId: result.personId, name: result.personName }
    : await findPersonalMaster(idNumber);

  const authorizationLabel = result.authorized
    ? getAuthorizationLabel(result.authorizationType)
    : getAuthorizationLabel(null);

  return {
    authorized: result.authorized,
    reason: result.denialReason || (result.authorized ? result.authorizationType : 'denied'),
    authorization: result.authorization,
    authorizationType: result.authorizationType,
    authorizationLabel,
    master,
    displayName: result.personName || parsedName,
    message: result.authorized
      ? `${authorizationLabel}${result.personName ? `: ${result.personName}` : ''}`
      : config.denyMessage,
    config,
    denialReason: result.denialReason
  };
};

const triggerAccessIfAuthorized = async ({
  movementType,
  idNumber,
  name,
  entrySource,
  entryId,
  username,
  allowManualOverride = null,
  doorId = null,
  readerId = null
}) => {
  const { openDoor } = require('./doorController');
  const access = await evaluatePersonalAccess({
    movementType,
    idNumber,
    name,
    entrySource,
    allowManualOverride,
    guardId: username
  });
  const config = access.config;

  if (!access.authorized || movementType !== config.triggerOn) {
    await logAccessEvent({
      type: 'denied',
      movementType,
      idNumber,
      name: access.displayName || name,
      entrySource,
      entryId,
      username,
      reason: access.reason,
      authorizationType: access.authorizationType,
      relayTriggered: false,
      doorId: doorId || null
    });
    return { ...access, relay: { triggered: false, skipped: true } };
  }

  if (!config.enabled) {
    await logAccessEvent({
      type: 'authorized',
      movementType,
      idNumber,
      name: access.displayName || name,
      entrySource,
      entryId,
      username,
      reason: access.reason,
      authorizationType: access.authorizationType,
      relayTriggered: false,
      note: 'Autorizado pero el relevador está deshabilitado',
      doorId: doorId || null
    });
    return {
      ...access,
      relay: { triggered: false, skipped: true, message: 'Autorizado sin activar relevador (deshabilitado)' }
    };
  }

  try {
    const openResult = await openDoor({
      doorId,
      readerId,
      username,
      personId: access.master?.personId || null,
      entryId,
      authMethod: 'dni',
      movementType
    });
    return { ...access, relay: openResult.relay, door: openResult.door, airlock: openResult.airlock };
  } catch (err) {
    await logAccessEvent({
      type: 'authorized',
      movementType,
      idNumber,
      name: access.displayName || name,
      entrySource,
      entryId,
      username,
      reason: access.reason,
      authorizationType: access.authorizationType,
      relayTriggered: false,
      relayError: err.message,
      doorId: doorId || null
    });
    return {
      ...access,
      relay: { triggered: false, error: err.message }
    };
  }
};

const processKioskScan = async ({ rawData, username, doorId = null, readerId = 'default' }) => {
  const { openDoor, resolveDoorContext } = require('./doorController');
  const { resolveScanContext } = require('./lib/accessAuthMethods');

  const { door, airlockState } = await resolveDoorContext({ doorId, readerId });
  const scan = await resolveScanContext({ rawData, door });

  if (!scan.ok) {
    return {
      ok: false,
      authorized: false,
      message: scan.message,
      authMethod: scan.authMethod || null,
      door: { id: door.id, name: door.name },
      airlock: airlockState
    };
  }

  let idNumber = scan.idNumber || '';
  let firstName = scan.firstName || '';
  let lastName = scan.lastName || '';
  let parsed = scan.parsed || {};
  let scanFormat = parsed.format || scan.authMethod || 'unknown';

  if (scan.authMethod === 'credential' && scan.person) {
    idNumber = scan.person.dniNormalized || scan.person.idNumberNormalized || '';
    const fullName = scan.displayName || scan.person.name || scan.person.nombre || '';
    const parts = fullName.split(/\s+/).filter(Boolean);
    lastName = parts[0] || '';
    firstName = parts.slice(1).join(' ') || fullName;
  } else if (scan.authMethod === 'credential') {
    parsed = { format: 'credential' };
    scanFormat = 'credential';
  } else {
    parsed = scan.parsed || parseScanData(rawData);
    idNumber = normalizeIdNumber(parsed.idNumber || idNumber);
    firstName = parsed.firstName || firstName;
    lastName = parsed.lastName || lastName;
    scanFormat = parsed.format || 'unknown';
  }

  const fallbackName = scan.displayName
    || parsed.name
    || [lastName, firstName].filter(Boolean).join(' ').trim();

  if (!idNumber && !fallbackName && scan.authMethod !== 'credential') {
    return {
      ok: false,
      authorized: false,
      message: 'No se pudo leer el documento. Acerque nuevamente el DNI.',
      scanFormat,
      door: { id: door.id, name: door.name }
    };
  }

  let result;
  if (scan.authMethod === 'credential' && scan.authorization && !scan.person) {
    result = {
      authorized: true,
      personId: null,
      personName: scan.displayName || scan.credentialCode,
      authorizationType: scan.authorization.type || 'credential',
      denialReason: null,
      entryId: null
    };
  } else {
    result = await validarAcceso({
      dni: idNumber,
      nombre: firstName,
      apellido: lastName,
      tipoMovimiento: 'ingreso',
      channel: 'molinete',
      guardId: username
    });
  }

  const config = await getAccessControlConfig();
  let authorized = result.authorized;
  let message = result.authorized
    ? `${getAuthorizationLabel(result.authorizationType)}${result.personName ? `: ${result.personName}` : ''}`
    : config.denyMessage;

  const nominaAccess = await buildNominaAccessMessage({
    personId: result.personId,
    dniNormalized: idNumber,
    personName: result.personName
  });

  if (nominaAccess) {
    message = nominaAccess.message;
    if (nominaAccess.authorized === true) authorized = true;
    else if (nominaAccess.authorized === false) authorized = false;
  }

  let relayTriggered = false;
  let relayError = null;
  let airlock = airlockState ? { groupId: door.airlockGroupId, state: airlockState } : null;

  if (authorized && config.enabled && config.triggerOn === 'ingreso' && door.autoOpenOnAuth !== false) {
    try {
      const openResult = await openDoor({
        doorId: door.id,
        username,
        personId: result.personId,
        entryId: result.entryId,
        authMethod: scan.authMethod,
        movementType: 'ingreso'
      });
      relayTriggered = true;
      airlock = openResult.airlock || airlock;
    } catch (err) {
      relayError = err.message;
      await logAccessEvent({
        type: 'authorized',
        movementType: 'ingreso',
        idNumber,
        name: result.personName,
        entrySource: 'kiosk',
        entryId: result.entryId,
        username,
        reason: result.authorizationType,
        authorizationType: result.authorizationType,
        relayTriggered: false,
        relayError: err.message,
        doorId: door.id,
        authMethod: scan.authMethod
      });
    }
  } else if (!authorized) {
    await logAccessEvent({
      type: 'denied',
      movementType: 'ingreso',
      idNumber,
      name: result.personName,
      entrySource: 'kiosk',
      entryId: result.entryId,
      username,
      reason: result.denialReason,
      authorizationType: null,
      relayTriggered: false,
      doorId: door.id,
      authMethod: scan.authMethod
    });
  }

  if (result.entryId) {
    await db.collection('entries').doc(result.entryId).update({
      relayTriggered,
      relayError,
      doorId: door.id,
      doorName: door.name,
      authMethod: scan.authMethod,
      company: parsed.company || '',
      destination: parsed.destination || '',
      scanFormat
    });
  }

  return {
    ok: true,
    authorized,
    message,
    authorizationLabel: getAuthorizationLabel(authorized ? (result.authorizationType || nominaAccess?.reason) : null),
    authorizationType: authorized ? (result.authorizationType || nominaAccess?.reason) : result.authorizationType,
    name: result.personName,
    idNumber,
    denialReason: authorized ? null : (nominaAccess?.reason || result.denialReason),
    personId: result.personId,
    scanFormat,
    authMethod: scan.authMethod,
    relayTriggered,
    relayError,
    entryId: result.entryId,
    door: { id: door.id, name: door.name, airlockRole: door.airlockRole },
    airlock
  };
};

const manualOpenDoor = async ({
  username,
  userId = null,
  reason = '',
  doorId = null,
  bypassAirlock = false
} = {}) => {
  const { openDoor } = require('./doorController');
  return openDoor({
    doorId,
    username,
    userId,
    reason: reason || 'apertura_manual_guardia',
    manual: true,
    bypassAirlock: bypassAirlock === true,
    force: true,
    authMethod: 'manual'
  });
};

module.exports = {
  TOLERANCIA_MINUTOS,
  DEFAULT_ACCESS_CONTROL,
  getAccessControlConfig,
  resolvePersonForValidarAcceso,
  fetchPrimaryAuthorizations,
  fetchRangeAuthorizations,
  fetchAuthorizationsForPerson,
  writeAccessEntry,
  decidirAcceso,
  validarAcceso,
  evaluatePersonalAccess,
  triggerAccessIfAuthorized,
  manualOpenDoor,
  isRelayConfigured: (config = {}) =>
    Boolean(String(config.bridgeUrl || '').trim()) || Boolean(String(config.host || '').trim()),
  triggerRelay,
  logAccessEvent,
  processKioskScan
};
