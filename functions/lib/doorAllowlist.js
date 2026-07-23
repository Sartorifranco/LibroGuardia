/**
 * Allowlist offline por puerta: resultado YA calculado con decidirAcceso
 * (misma lógica de negocio que online). No reimplementa reglas.
 */

const { db } = require('../firestore');
const { getDoorsConfig, findDoorById } = require('./doorsConfig');
const { getAccessControlConfig } = require('./accessControlStore');
const { buildRelayConfigForDoor } = require('../doorController');
const { buildLocalRelayPayload, resolveRelayMode } = require('./relayDispatch');
const { normalizeDni, getArgentinaDateParts, buildFullName } = require('./normalize');
const { endOfArgentinaDay } = require('./visitasAccess');

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

const loadPeopleCandidates = async () => {
  const snap = await db.collection('people').get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

/**
 * DNIs de visitas vigentes que podrían no estar en people.
 */
const loadVisitaDniCandidates = async (referenceDate = new Date()) => {
  let snap;
  try {
    snap = await db.collection('visitas').limit(300).get();
  } catch {
    return [];
  }

  const out = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
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

/**
 * Construye la allowlist de ingreso para una puerta usando decidirAcceso.
 *
 * @param {string} doorId
 * @param {{ referenceDate?: Date, decidirAccesoFn?: Function }} [options]
 */
const buildDoorAllowlist = async (doorId, options = {}) => {
  const id = String(doorId || '').trim();
  if (!id) throw httpError(400, 'doorId es obligatorio');

  const referenceDate = options.referenceDate || new Date();
  const decidirAccesoFn = options.decidirAccesoFn
    || require('../accessControl').decidirAcceso;

  const doorsConfig = await getDoorsConfig();
  const door = findDoorById(doorsConfig, id);
  if (!door || door.active === false) {
    throw httpError(404, `Puerta no encontrada: ${id}`, 'unknown_door');
  }

  const accessConfig = await getAccessControlConfig();
  const relayConfig = buildRelayConfigForDoor(door, accessConfig);
  const localRelay = buildLocalRelayPayload(relayConfig);

  const people = await loadPeopleCandidates();
  const visitaExtras = await loadVisitaDniCandidates(referenceDate);

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

  // Misma lógica (decidirAcceso); solo paraleliza lecturas independientes.
  const concurrency = Math.max(1, Number(options.concurrency) || 12);
  const evaluated = await mapPool(candidates, concurrency, async (candidate) => {
    const dni = candidate.dniNormalized;
    const resolvedPerson = candidate.person
      ? {
        personId: candidate.personId || candidate.person.id,
        person: candidate.person,
        dniNormalized: dni,
        nameSnapshot: personDisplayName(candidate.person) || buildFullName(candidate.nombre, candidate.apellido),
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

    if (!decision?.authorized) return null;

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
  });

  const entries = evaluated.filter(Boolean);
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
  combineDateAndTimeAr
};
