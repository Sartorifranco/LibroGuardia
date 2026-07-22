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

const { db, FieldValue } = require('../firestore');
const { normalizeDni } = require('./normalize');
const { getArgentinaDateParts } = require('./normalize');
const { isDoorAllowedForIngreso, normalizeAllowedDoorIds } = require('./doorAccess');

const VISITAS = 'visitas';
const EARLY_MS = 2 * 60 * 60 * 1000;

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

module.exports = {
  EARLY_MS,
  isVisitaWithinWindow,
  findEligibleVisita,
  markVisitaEstado,
  nextEstadoForMovement,
  endOfArgentinaDay,
  toDate,
  filterOwnVisitas
};
