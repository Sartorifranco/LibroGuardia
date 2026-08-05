/**
 * Allowlist offline por puerta: misma lógica de negocio que decidirAcceso,
 * pero con lecturas Firestore en lote (no N queries por persona).
 *
 * Motivo: Hosting corta requests ~60s; el path viejo (decidirAcceso × gente)
 * superaba ese límite y la mini PC veía "Timeout de red".
 */

const { db } = require('../firestore');
const { getDoorsConfig, findDoorById } = require('./doorsConfig');
const { getAccessControlConfig } = require('./accessControlStore');
const { buildRelayConfigForDoor } = require('../doorController');
const { buildLocalRelayPayload, resolveRelayMode } = require('./relayDispatch');
const { normalizeDni, getArgentinaDateParts, buildFullName } = require('./normalize');
const { endOfArgentinaDay, findEligibleVisita } = require('./visitasAccess');
const { evaluateAuthorizationCandidates } = require('./accessValidation');
const { hydrateAuthorizationForRead } = require('./transportCsvParser');
const { applyDoorRestrictionForIngreso } = require('./doorAccess');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const personDisplayName = (person = {}) =>
  String(person.nombre || person.name || '').trim();

const splitName = (fullName = '') => {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { nombre: '', apellido: '' };
  if (parts.length === 1) return { nombre: parts[0], apellido: '' };
  return { apellido: parts[0], nombre: parts.slice(1).join(' ') };
};

const combineDateAndTimeAr = (dateString, hhmm) => {
  if (!dateString) return null;
  const time = String(hhmm || '23:59').trim();
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return new Date(`${dateString}T23:59:59.999-03:00`);
  }
  const hh = String(match[1]).padStart(2, '0');
  const mm = String(match[2]).padStart(2, '0');
  return new Date(`${dateString}T${hh}:${mm}:00.000-03:00`);
};

/**
 * Hasta cuándo vale la entrada en la allowlist (ISO), o null si no vence
 * por fecha (p.ej. permanente sin ventana).
 */
const resolveValidUntil = (decision, referenceDate = new Date()) => {
  const { dateString: today } = getArgentinaDateParts(referenceDate);
  const auth = decision?.authorization;

  if (decision?.authorizationType === 'visita_empleado') {
    return endOfArgentinaDay(referenceDate).toISOString();
  }

  if (!auth) return null;

  const type = String(auth.type || '').toLowerCase();
  if (type === 'permanent') {
    if (auth.timeWindow?.to) {
      return combineDateAndTimeAr(today, auth.timeWindow.to)?.toISOString() || null;
    }
    return null;
  }

  if (type === 'citacion') {
    const date = auth.appointmentDate || auth.startDate || today;
    if (auth.timeWindow?.to) {
      return combineDateAndTimeAr(date, auth.timeWindow.to)?.toISOString() || null;
    }
    return combineDateAndTimeAr(date, '23:59')?.toISOString() || null;
  }

  if (['visita', 'visit', 'temporal'].includes(type)) {
    const end = auth.endDate || auth.startDate || today;
    if (auth.timeWindow?.to) {
      return combineDateAndTimeAr(end, auth.timeWindow.to)?.toISOString() || null;
    }
    return combineDateAndTimeAr(end, '23:59')?.toISOString() || null;
  }

  return null;
};

const mapPool = async (items, concurrency, mapper) => {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(concurrency, list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const idx = next;
      next += 1;
      results[idx] = await mapper(list[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
};

// Las inactivas nunca llegan a la allowlist (decideCandidateOffline las rechaza),
// pero traerlas costaba una lectura cada una: en agosto de 2026 eran 583 de 847.
const loadPeopleCandidates = async () => {
  const snap = await db.collection('people').where('active', '==', true).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

/**
 * Carga visitas (docs completos) para evaluar elegibilidad en memoria.
 */
const loadVisitasDocs = async () => {
  try {
    const snap = await db.collection('visitas').limit(300).get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch {
    return [];
  }
};

/**
 * DNIs de visitas vigentes que podrían no estar en people.
 */
const loadVisitaDniCandidatesFromDocs = (visitasDocs = []) => {
  const out = [];
  for (const data of visitasDocs) {
    const estado = data.estado;
    if (estado !== 'pendiente' && estado !== 'autorizada') continue;
    const dni = normalizeDni(data.dniVisitanteNormalized || data.dniVisitante || '');
    if (!dni) continue;
    out.push({
      dniNormalized: dni,
      nombre: String(data.nombreVisitante || '').trim()
    });
  }
  return out;
};

const mapAuthDoc = (doc) => hydrateAuthorizationForRead({ id: doc.id, ...doc.data() });

/**
 * Autorizaciones activas relevantes para hoy, indexadas por personId.
 * 3 lecturas en paralelo en lugar de 2–3 por persona.
 */
const loadAuthorizationsByPersonId = async (today) => {
  const col = db.collection('authorizations');
  const [permanentSnap, citacionSnap, rangeSnap] = await Promise.all([
    col.where('active', '==', true).where('type', '==', 'permanent').get(),
    col
      .where('active', '==', true)
      .where('type', '==', 'citacion')
      .where('appointmentDate', '==', today)
      .get(),
    col
      .where('active', '==', true)
      .where('type', 'in', ['visita', 'visit', 'temporal'])
      .get()
  ]);

  const byPerson = new Map();
  const ensure = (personId) => {
    if (!byPerson.has(personId)) {
      byPerson.set(personId, { permanentDocs: [], citacionDocs: [], rangeDocs: [] });
    }
    return byPerson.get(personId);
  };

  for (const doc of permanentSnap.docs) {
    const auth = mapAuthDoc(doc);
    if (!auth.personId) continue;
    ensure(auth.personId).permanentDocs.push(auth);
  }
  for (const doc of citacionSnap.docs) {
    const auth = mapAuthDoc(doc);
    if (!auth.personId) continue;
    ensure(auth.personId).citacionDocs.push(auth);
  }
  for (const doc of rangeSnap.docs) {
    const auth = mapAuthDoc(doc);
    if (!auth.personId) continue;
    const endDate = auth.endDate || auth.startDate;
    if (!auth.startDate || !endDate || today < auth.startDate || today > endDate) continue;
    ensure(auth.personId).rangeDocs.push(auth);
  }

  return byPerson;
};

/**
 * Evalúa un candidato con datos ya cargados (sin I/O por persona).
 * Misma semántica que decidirAcceso para ingreso + puerta.
 * Siempre devuelve { authorized, denialReason?, ... } (nunca null).
 */
const decideCandidateOffline = async ({
  candidate,
  doorId,
  referenceDate,
  today,
  dayCode,
  authByPersonId,
  visitasDocs
}) => {
  const dni = candidate.dniNormalized;
  const person = candidate.person;
  const personId = candidate.personId || person?.id || null;
  const nameSnapshot = person
    ? (personDisplayName(person) || buildFullName(candidate.nombre, candidate.apellido))
    : buildFullName(candidate.nombre, candidate.apellido);

  const base = {
    personId,
    personName: nameSnapshot,
    dniNormalized: dni,
    authorization: null,
    authorizationType: null,
    allowedDoorIds: person?.allowedDoorIds ?? []
  };

  if (person && person.active === false) {
    return { ...base, authorized: false, denialReason: 'persona_inactiva' };
  }

  let authorization = null;
  let authorizationType = null;
  let authorized = false;
  let denialReason = personId ? null : 'no_encontrado';

  if (personId) {
    const bucket = authByPersonId.get(personId) || {
      permanentDocs: [],
      citacionDocs: [],
      rangeDocs: []
    };
    let evaluation = evaluateAuthorizationCandidates({
      permanentDocs: bucket.permanentDocs,
      citacionDocs: bucket.citacionDocs,
      rangeDocs: [],
      today,
      dayCode,
      referenceDate
    });
    if (!evaluation.authorization) {
      evaluation = evaluateAuthorizationCandidates({
        permanentDocs: [],
        citacionDocs: [],
        rangeDocs: bucket.rangeDocs,
        today,
        dayCode,
        referenceDate
      });
    }
    authorization = evaluation.authorization;
    denialReason = evaluation.denialReason;
    if (authorization) {
      authorized = true;
      authorizationType = authorization.type;
      denialReason = null;
    } else if (!denialReason) {
      denialReason = 'sin_citacion_para_hoy';
    }
  }

  let allowedDoorIds = authorization?.allowedDoorIds != null
    ? authorization.allowedDoorIds
    : (person?.allowedDoorIds ?? []);

  if (!authorized) {
    const visitaMatch = await findEligibleVisita({
      dniNormalized: dni,
      doorId,
      movementType: 'ingreso',
      now: referenceDate,
      visitasDocs
    });
    if (visitaMatch.visita) {
      return {
        ...base,
        authorized: true,
        denialReason: null,
        personName: visitaMatch.visita.nombreVisitante || nameSnapshot,
        authorizationType: 'visita_empleado',
        authorization: null,
        allowedDoorIds: visitaMatch.allowedDoorIds
      };
    }
    if (visitaMatch.reason === 'puerta_no_autorizada') {
      return {
        ...base,
        authorized: false,
        denialReason: 'puerta_no_autorizada',
        allowedDoorIds: visitaMatch.allowedDoorIds || allowedDoorIds
      };
    }
  }

  const restricted = applyDoorRestrictionForIngreso({
    authorized,
    denialReason,
    allowedDoorIds,
    doorId,
    movementType: 'ingreso'
  });

  return {
    ...base,
    authorized: Boolean(restricted.authorized),
    denialReason: restricted.authorized ? null : (restricted.denialReason || denialReason || 'denegado'),
    authorizationType: restricted.authorized ? authorizationType : null,
    authorization: restricted.authorized ? authorization : null,
    allowedDoorIds
  };
};

const toAllowlistEntry = (decision, candidate, referenceDate) => {
  if (!decision?.authorized) return null;
  const dni = candidate.dniNormalized;
  return {
    dniNormalized: decision.dniNormalized || dni,
    legajoNormalized: candidate.legajoNormalized
      ? String(candidate.legajoNormalized).trim()
      : (candidate.person?.legajoNormalized || candidate.person?.legajo || null),
    nombre: decision.personName
      || personDisplayName(candidate.person)
      || buildFullName(candidate.nombre, candidate.apellido),
    authorizationType: decision.authorizationType || null,
    validUntil: resolveValidUntil(decision, referenceDate),
    personId: decision.personId || null
  };
};

/**
 * Construye la allowlist de ingreso para una puerta.
 *
 * @param {string} doorId
 * @param {{ referenceDate?: Date, decidirAccesoFn?: Function, concurrency?: number }} [options]
 *   Si pasás decidirAccesoFn (tests), usa el path lento por candidato.
 */
const buildDoorAllowlist = async (doorId, options = {}) => {
  const id = String(doorId || '').trim();
  if (!id) throw httpError(400, 'doorId es obligatorio');

  const referenceDate = options.referenceDate || new Date();
  const { dateString: today, dayCode } = getArgentinaDateParts(referenceDate);

  const doorsConfig = await getDoorsConfig();
  const door = findDoorById(doorsConfig, id);
  if (!door || door.active === false) {
    throw httpError(404, `Puerta no encontrada: ${id}`, 'unknown_door');
  }

  const accessConfig = await getAccessControlConfig();
  const relayConfig = buildRelayConfigForDoor(door, accessConfig);
  const localRelay = buildLocalRelayPayload(relayConfig);

  const [people, visitasDocs] = await Promise.all([
    loadPeopleCandidates(),
    loadVisitasDocs()
  ]);
  const visitaExtras = loadVisitaDniCandidatesFromDocs(visitasDocs);

  const candidates = [];
  const queuedDnis = new Set();

  for (const person of people) {
    const dni = normalizeDni(
      person.dniNormalized
      || person.dni
      || person.idNumberNormalized
      || person.idNumber
      || ''
    );
    if (!dni || queuedDnis.has(dni)) continue;
    queuedDnis.add(dni);
    const display = personDisplayName(person);
    const { nombre, apellido } = splitName(display);
    candidates.push({
      dniNormalized: dni,
      nombre,
      apellido,
      person,
      personId: person.id,
      legajoNormalized: person.legajoNormalized || person.legajo || null
    });
  }

  for (const visita of visitaExtras) {
    const dni = normalizeDni(visita.dniNormalized);
    if (!dni || queuedDnis.has(dni)) continue;
    queuedDnis.add(dni);
    const { nombre, apellido } = splitName(visita.nombre);
    candidates.push({
      dniNormalized: dni,
      nombre,
      apellido,
      person: null,
      personId: null,
      legajoNormalized: null
    });
  }

  let entries;

  // Path de tests: inyección de decidirAcceso (compat).
  if (typeof options.decidirAccesoFn === 'function') {
    const decidirAccesoFn = options.decidirAccesoFn;
    const concurrency = Math.max(1, Number(options.concurrency) || 12);
    const evaluated = await mapPool(candidates, concurrency, async (candidate) => {
      const dni = candidate.dniNormalized;
      const resolvedPerson = candidate.person
        ? {
          personId: candidate.personId || candidate.person.id,
          person: candidate.person,
          dniNormalized: dni,
          nameSnapshot: personDisplayName(candidate.person)
            || buildFullName(candidate.nombre, candidate.apellido),
          resolutionPath: 'allowlist'
        }
        : {
          personId: null,
          person: null,
          dniNormalized: dni,
          nameSnapshot: buildFullName(candidate.nombre, candidate.apellido),
          resolutionPath: 'allowlist_visita'
        };

      const decision = await decidirAccesoFn({
        dni,
        nombre: candidate.nombre,
        apellido: candidate.apellido,
        tipoMovimiento: 'ingreso',
        doorId: id,
        referenceDate,
        resolvedPerson
      });
      return toAllowlistEntry(decision, candidate, referenceDate);
    });
    entries = evaluated.filter(Boolean);
  } else {
    const authByPersonId = await loadAuthorizationsByPersonId(today);
    const evaluated = await Promise.all(candidates.map((candidate) =>
      decideCandidateOffline({
        candidate,
        doorId: id,
        referenceDate,
        today,
        dayCode,
        authByPersonId,
        visitasDocs
      }).then((decision) => toAllowlistEntry(decision, candidate, referenceDate))
    ));
    entries = evaluated.filter(Boolean);
  }

  entries.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));

  return {
    doorId: id,
    doorName: door.name || id,
    generatedAt: new Date().toISOString(),
    relayMode: resolveRelayMode(door),
    localRelay,
    count: entries.length,
    entries
  };
};

module.exports = {
  buildDoorAllowlist,
  resolveValidUntil,
  combineDateAndTimeAr,
  decideCandidateOffline,
  loadAuthorizationsByPersonId,
  loadVisitasDocs
};
