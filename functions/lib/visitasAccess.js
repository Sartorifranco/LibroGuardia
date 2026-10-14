/**
 * Visitas de empleados (colección 'visitas') — vigencia y match para acceso.
 *
 * Ventana de vigencia (ingreso): según `duracion`, la misma que el pase del borde
 * (siteCompiler/build.js visitPassWindow). Un solo ingreso (default):
 *   desde fechaHoraEsperada − 2 horas
 *   hasta validoHasta o el fin del día calendario AR (23:59:59.999 AR).
 * Motivo: el visitante suele llegar antes; el mismo día laboral debe alcanzar
 * para completar el ingreso. El egreso (estado ingreso_registrado) no revalida
 * la ventana para no dejar gente atrapada tras el cierre del día.
 */

const { db, FieldValue, Timestamp } = require('../firestore');
const { normalizeDni } = require('./normalize');
const { getArgentinaDateParts } = require('./normalize');
const { isDoorAllowedForIngreso, normalizeAllowedDoorIds } = require('./doorAccess');
const { parsePassCode, looksLikePassCode } = require('./visitPassCode');
const { visitPassWindow } = require('./siteCompiler/build');

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
 * Recibe la fecha esperada (ventana de un solo ingreso) o la visita completa
 * (ventana según `duracion`, igual que el pase del borde).
 * @returns {{ ok: boolean, reason?: string, windowStart?: Date, windowEnd?: Date }}
 */
const isVisitaWithinWindow = (fechaHoraEsperadaOrVisita, now = new Date()) => {
  const raw = fechaHoraEsperadaOrVisita;
  const isVisita = raw && typeof raw === 'object' && !(raw instanceof Date) && typeof raw.toDate !== 'function'
    && Object.prototype.hasOwnProperty.call(raw, 'fechaHoraEsperada');
  const win = visitPassWindow(isVisita ? raw : { fechaHoraEsperada: toDate(raw) });
  if (!win) return { ok: false, reason: 'visita_sin_fecha' };
  const windowStart = new Date(win.validFrom);
  const windowEnd = new Date(win.validTo);
  const t = now.getTime();
  if (t < windowStart.getTime()) {
    return { ok: false, reason: 'visita_antes_de_ventana', windowStart, windowEnd };
  }
  if (t > windowEnd.getTime()) {
    return { ok: false, reason: 'visita_fuera_de_ventana', windowStart, windowEnd };
  }
  return { ok: true, windowStart, windowEnd };
};

const isMultiEntry = (visita) => ['horas', 'dia', 'mes'].includes(visita && visita.duracion);

const normalizeVisitaDoc = (doc) => {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || data.id;
  return { id, ...data };
};

/** Visita por código de pase (QR). Sin match o formato inválido → null. */
const findVisitaByPassCode = async (rawCode, { visitasDocs = null } = {}) => {
  const code = parsePassCode(rawCode);
  if (!code) return null;
  let docs;
  if (Array.isArray(visitasDocs)) {
    docs = visitasDocs.map(normalizeVisitaDoc).filter(Boolean);
  } else {
    const snap = await db.collection(VISITAS).where('passCode', '==', code).limit(2).get();
    docs = snap.docs.map((d) => normalizeVisitaDoc(d));
  }
  return docs.find((v) => v.passCode === code) || null;
};

/**
 * Busca visita elegible para ingreso o egreso, por DNI o por código de pase (QR).
 * Un valor con prefijo MSSV1. (en passCode o en dniNormalized) nunca se trata como DNI.
 * @param {{ dniNormalized?: string, passCode?: string|null, doorId?: string|null, movementType?: string, now?: Date, visitasDocs?: object[] }} args
 *   Si pasás visitasDocs, no consulta Firestore (tests).
 */
const findEligibleVisita = async ({
  dniNormalized,
  passCode = null,
  doorId = null,
  movementType = 'ingreso',
  now = new Date(),
  visitasDocs = null
} = {}) => {
  const byCode = looksLikePassCode(passCode) || looksLikePassCode(dniNormalized);
  let matches;
  let docs;
  if (byCode) {
    const code = parsePassCode(looksLikePassCode(passCode) ? passCode : dniNormalized);
    if (!code) return { visita: null, reason: 'pase_invalido' };
    const found = await findVisitaByPassCode(code, { visitasDocs });
    docs = found ? [found] : [];
    matches = (v) => v.passCode === code;
  } else {
    const dni = normalizeDni(dniNormalized);
    if (!dni) return { visita: null, reason: 'dni_vacio' };
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
    matches = (v) => normalizeDni(v.dniVisitanteNormalized || v.dniVisitante || '') === dni;
  }

  const movement = movementType === 'egreso' ? 'egreso' : 'ingreso';
  const candidates = docs.filter((v) => {
    if (!matches(v)) return false;
    if (movement === 'ingreso') {
      if (v.estado === 'pendiente' || v.estado === 'autorizada') return true;
      // Por horas, día o mes: después de salir puede volver a entrar dentro de la ventana.
      return v.estado === 'egreso_registrado' && isMultiEntry(v);
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
      const win = isVisitaWithinWindow(visita, now);
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
  require('./siteCompiler').markDirty({ visitas: [visitaId] });
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
    ingresoAt: toDate(v.ingresoAt) ? toDate(v.ingresoAt).toISOString() : null,
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
  findVisitaByPassCode,
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
