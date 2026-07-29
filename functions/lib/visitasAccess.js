/**
 * Visitas de empleados (colección 'visitas') — vigencia y match para acceso.
 *
 * Ventana de vigencia (ingreso):
 *   desde fechaHoraEsperada − 2 horas
 *   hasta el fin del día calendario de fechaHoraEsperada en America/Argentina/Buenos_Aires
 *   (23:59:59.999 AR).
 * Motivo: el visitante suele llegar antes; el mismo día laboral debe alcanzar
 * para completar el ingreso. El egreso (estado ingreso_registrado) no revalida
 * la ventana para no dejar gente atrapada tras el cierre del día.
 */

const { db, FieldValue, Timestamp } = require('../firestore');
const { normalizeDni } = require('./normalize');
const { getArgentinaDateParts } = require('./normalize');
const { isDoorAllowedForIngreso, normalizeAllowedDoorIds } = require('./doorAccess');

const VISITAS = 'visitas';
const EARLY_MS = 2 * 60 * 60 * 1000;
const LIST_ESTADOS = new Set(['pendiente', 'autorizada', 'ingreso_registrado']);

const toDate = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Fin del día AR de una fecha ISO/Date → Date UTC equivalente a 23:59:59.999 AR. */
const endOfArgentinaDay = (referenceDate) => {
  const { dateString } = getArgentinaDateParts(referenceDate);
  // dateString = YYYY-MM-DD en AR
  return new Date(`${dateString}T23:59:59.999-03:00`);
};

/**
 * @returns {{ ok: boolean, reason?: string, windowStart?: Date, windowEnd?: Date }}
 */
const isVisitaWithinWindow = (fechaHoraEsperada, now = new Date()) => {
  const expected = toDate(fechaHoraEsperada);
  if (!expected) return { ok: false, reason: 'visita_sin_fecha' };
  const windowStart = new Date(expected.getTime() - EARLY_MS);
  const windowEnd = endOfArgentinaDay(expected);
  const t = now.getTime();
  if (t < windowStart.getTime()) {
    return { ok: false, reason: 'visita_antes_de_ventana', windowStart, windowEnd };
  }
  if (t > windowEnd.getTime()) {
    return { ok: false, reason: 'visita_fuera_de_ventana', windowStart, windowEnd };
  }
  return { ok: true, windowStart, windowEnd };
};

const normalizeVisitaDoc = (doc) => {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || data.id;
  return { id, ...data };
};

/**
 * Busca visita elegible para ingreso o egreso.
 * @param {{ dniNormalized: string, doorId?: string|null, movementType?: string, now?: Date, visitasDocs?: object[] }} args
 *   Si pasás visitasDocs, no consulta Firestore (tests).
 */
const findEligibleVisita = async ({
  dniNormalized,
  doorId = null,
  movementType = 'ingreso',
  now = new Date(),
  visitasDocs = null
} = {}) => {
  const dni = normalizeDni(dniNormalized);
  if (!dni) return { visita: null, reason: 'dni_vacio' };

  let docs;
  if (Array.isArray(visitasDocs)) {
    docs = visitasDocs.map(normalizeVisitaDoc).filter(Boolean);
  } else {
    let snap;
    try {
      snap = await db.collection(VISITAS)
        .where('dniVisitanteNormalized', '==', dni)
        .limit(40)
        .get();
    } catch {
      snap = await db.collection(VISITAS).orderBy('createdAt', 'desc').limit(80).get();
    }
    docs = snap.docs.map((d) => normalizeVisitaDoc(d));
  }

  const movement = movementType === 'egreso' ? 'egreso' : 'ingreso';
  const candidates = docs.filter((v) => {
    const vDni = normalizeDni(v.dniVisitanteNormalized || v.dniVisitante || '');
    if (vDni !== dni) return false;
    if (movement === 'ingreso') {
      return v.estado === 'pendiente' || v.estado === 'autorizada';
    }
    return v.estado === 'ingreso_registrado';
  });

  if (!candidates.length) {
    return { visita: null, reason: 'visita_no_encontrada' };
  }

  // Preferir la más próxima a ahora por fechaHoraEsperada
  candidates.sort((a, b) => {
    const ta = toDate(a.fechaHoraEsperada)?.getTime() || 0;
    const tb = toDate(b.fechaHoraEsperada)?.getTime() || 0;
    return Math.abs(ta - now.getTime()) - Math.abs(tb - now.getTime());
  });

  for (const visita of candidates) {
    if (movement === 'ingreso') {
      const win = isVisitaWithinWindow(visita.fechaHoraEsperada, now);
      if (!win.ok) {
        continue;
      }
    }

    const doors = normalizeAllowedDoorIds(visita.allowedDoorIds);
    if (!isDoorAllowedForIngreso(doors, doorId)) {
      return {
        visita: null,
        reason: 'puerta_no_autorizada',
        deniedVisitaId: visita.id,
        allowedDoorIds: doors
      };
    }

    return {
      visita,
      reason: null,
      allowedDoorIds: doors
    };
  }

  return { visita: null, reason: 'visita_fuera_de_ventana' };
};

const markVisitaEstado = async (visitaId, estado) => {
  if (!visitaId) return;
  await db.collection(VISITAS).doc(visitaId).set({
    estado,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
};

const nextEstadoForMovement = (movementType) =>
  (movementType === 'egreso' ? 'egreso_registrado' : 'ingreso_registrado');

/** Defensa en profundidad: solo visitas del usuario autenticado. */
const filterOwnVisitas = (visitas, userId) =>
  (visitas || []).filter((v) => v.createdByUserId === userId);

/** Bounds UTC del día calendario AR (YYYY-MM-DD). */
const argentinaDayBounds = (dateString) => {
  const day = String(dateString || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return {
    start: new Date(`${day}T00:00:00.000-03:00`),
    end: new Date(`${day}T23:59:59.999-03:00`)
  };
};

/**
 * Fila compatible con Autorizados (authorizations JSON) para una visita de empleado.
 * @param {object} visita
 * @param {{ empresaNombre?: string, autorizadoPor?: string }} [meta]
 */
const visitaToAuthorizationRow = (visita, meta = {}) => {
  const v = normalizeVisitaDoc(visita);
  if (!v?.id) return null;
  const expected = toDate(v.fechaHoraEsperada);
  const startDate = expected ? getArgentinaDateParts(expected).dateString : '';
  const dni = normalizeDni(v.dniVisitanteNormalized || v.dniVisitante || '');
  const empresaNombre = String(meta.empresaNombre || v.empresaNombre || '').trim();
  const autorizadoPor = String(
    meta.autorizadoPor
    || v.createdByNombre
    || v.autorizadoPor
    || v.createdByUserId
    || ''
  ).trim();
  return {
    id: `visita:${v.id}`,
    visitaId: v.id,
    type: 'visita_empleado',
    name: v.nombreVisitante || '',
    idNumber: dni || String(v.dniVisitante || ''),
    legajo: '',
    company: v.destinoNombre || '',
    destination: v.destinoNombre || '',
    empresaId: v.empresaId || '',
    empresaNombre,
    createdByUserId: v.createdByUserId || '',
    createdByNombre: v.createdByNombre || autorizadoPor,
    autorizadoPor: autorizadoPor || v.createdByUserId || '',
    startDate,
    endDate: startDate,
    fechaHoraEsperada: expected ? expected.toISOString() : null,
    source: 'empleado',
    estado: v.estado || 'pendiente',
    active: true
  };
};

const loadEmpresaNombres = async (empresaIds = []) => {
  const map = new Map();
  const ids = [...new Set(empresaIds.map((id) => String(id || '').trim()).filter(Boolean))];
  await Promise.all(ids.map(async (id) => {
    try {
      const snap = await db.collection('empresas').doc(id).get();
      if (snap.exists) {
        const data = snap.data() || {};
        map.set(id, String(data.nombre || data.name || id).trim());
      }
    } catch {
      // ignore missing
    }
  }));
  return map;
};

const loadUserLabels = async (userIds = []) => {
  const map = new Map();
  const ids = [...new Set(userIds.map((id) => String(id || '').trim()).filter(Boolean))];
  await Promise.all(ids.map(async (id) => {
    try {
      const snap = await db.collection('users').doc(id).get();
      if (snap.exists) {
        const data = snap.data() || {};
        const label = String(data.nombre || data.name || data.username || data.email || id).trim();
        map.set(id, label || id);
      } else {
        map.set(id, id);
      }
    } catch {
      map.set(id, id);
    }
  }));
  return map;
};

/**
 * Visitas esperadas cuyo fechaHoraEsperada cae en el día AR indicado.
 * @param {string} dateString YYYY-MM-DD
 * @param {{ visitasDocs?: object[], skipLookups?: boolean }} [opts]
 */
const listVisitasEsperadasForDate = async (dateString, opts = {}) => {
  const bounds = argentinaDayBounds(dateString);
  if (!bounds) return [];

  const { start, end } = bounds;
  let docs;
  if (Array.isArray(opts.visitasDocs)) {
    docs = opts.visitasDocs.map(normalizeVisitaDoc).filter(Boolean);
  } else {
    let snap;
    try {
      snap = await db.collection(VISITAS)
        .where('fechaHoraEsperada', '>=', Timestamp.fromDate(start))
        .where('fechaHoraEsperada', '<=', Timestamp.fromDate(end))
        .limit(300)
        .get();
    } catch {
      snap = await db.collection(VISITAS).orderBy('createdAt', 'desc').limit(200).get();
    }
    docs = snap.docs.map((d) => normalizeVisitaDoc(d));
  }

  const startMs = start.getTime();
  const endMs = end.getTime();

  const filtered = docs.filter((v) => {
    if (!LIST_ESTADOS.has(v.estado || 'pendiente')) return false;
    const expected = toDate(v.fechaHoraEsperada);
    if (!expected) return false;
    const t = expected.getTime();
    return t >= startMs && t <= endMs;
  });

  let empresaMap = new Map();
  let userMap = new Map();
  if (!opts.skipLookups && !Array.isArray(opts.visitasDocs)) {
    [empresaMap, userMap] = await Promise.all([
      loadEmpresaNombres(filtered.map((v) => v.empresaId)),
      loadUserLabels(filtered.map((v) => v.createdByUserId))
    ]);
  } else if (Array.isArray(opts.visitasDocs)) {
    // Tests / inyección: usar campos ya presentes en el doc
    filtered.forEach((v) => {
      if (v.empresaNombre) empresaMap.set(v.empresaId, v.empresaNombre);
      if (v.autorizadoPor || v.createdByNombre) {
        userMap.set(v.createdByUserId, v.autorizadoPor || v.createdByNombre);
      }
    });
  }

  return filtered
    .map((v) => visitaToAuthorizationRow(v, {
      empresaNombre: empresaMap.get(v.empresaId) || v.empresaNombre || '',
      autorizadoPor:
        v.createdByNombre
        || userMap.get(v.createdByUserId)
        || v.autorizadoPor
        || v.createdByUserId
        || ''
    }))
    .filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));
};

module.exports = {
  EARLY_MS,
  LIST_ESTADOS,
  isVisitaWithinWindow,
  findEligibleVisita,
  markVisitaEstado,
  nextEstadoForMovement,
  endOfArgentinaDay,
  toDate,
  filterOwnVisitas,
  argentinaDayBounds,
  visitaToAuthorizationRow,
  listVisitasEsperadasForDate,
  loadEmpresaNombres,
  loadUserLabels
};
