/**
 * Duración del QR de una visita (docs/VISITAS-DISENO.md §3.0): validación del alta
 * y la edición. La ventana en sí la calcula siteCompiler/build.js visitPassWindow
 * (la misma para el borde, la nube y el vencimiento del link).
 */

const { visitPassWindow, VISITA_DURACIONES, ymdOf, addDays, dayEndMs, DEFAULT_TZ } = require('./siteCompiler/build');

const MAX_MES_DAYS = 31;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' = fin de ese día local; cualquier otra cosa = instante. */
const parseValidoHasta = (raw, tz) => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw && typeof raw.toDate === 'function') return raw.toDate();
  const s = String(raw).trim();
  if (DATE_ONLY_RE.test(s)) return new Date(dayEndMs(s, tz));
  const d = raw instanceof Date ? raw : new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * @param {{ duracion?: string, expected: Date, validoHasta?: any, scheduleId?: string }} input
 * @returns {{ error: string }|{ duracion: string, validoHasta: Date, scheduleId: string|null, validFrom: number, validTo: number, requiresApproval: boolean }}
 */
const resolveVisitDuration = ({ duracion: rawDuracion, expected, validoHasta: rawHasta, scheduleId: rawSchedule }, { tz = DEFAULT_TZ } = {}) => {
  const duracion = rawDuracion === undefined || rawDuracion === null || rawDuracion === ''
    ? 'un_ingreso'
    : String(rawDuracion).trim();
  if (!VISITA_DURACIONES.includes(duracion)) {
    return { error: 'Elegí la duración del pase: un solo ingreso, por horas, todo el día o por mes.' };
  }
  const until = parseValidoHasta(rawHasta, tz);
  if (until === undefined) return { error: 'La fecha u hora de fin no es válida.' };
  const startMs = expected.getTime();
  const sameDay = until && ymdOf(until.getTime(), tz) === ymdOf(startMs, tz);

  if (duracion === 'horas' && !until) return { error: 'Indicá hasta qué hora vale el pase.' };
  if (duracion === 'mes' && !until) return { error: 'Indicá hasta qué día vale el pase.' };
  if (until && (duracion === 'un_ingreso' || duracion === 'horas')) {
    if (!sameDay) return { error: 'La hora de fin tiene que ser el mismo día de la visita.' };
    if (until.getTime() <= startMs) return { error: 'La hora de fin tiene que ser después de la hora de inicio.' };
  }
  if (duracion === 'mes') {
    const startDay = ymdOf(startMs, tz);
    const endDay = ymdOf(until.getTime(), tz);
    if (endDay < startDay) return { error: 'El último día tiene que ser igual o posterior al primero.' };
    if (endDay > addDays(startDay, MAX_MES_DAYS - 1)) {
      return { error: `El pase por mes puede durar como máximo ${MAX_MES_DAYS} días.` };
    }
  }

  const scheduleId = duracion === 'mes' && rawSchedule ? String(rawSchedule).trim() || null : null;
  const win = visitPassWindow({
    fechaHoraEsperada: expected,
    duracion,
    validoHasta: duracion === 'mes' ? new Date(dayEndMs(ymdOf(until.getTime(), tz), tz)) : until,
    scheduleId
  }, tz);
  return {
    duracion,
    validoHasta: new Date(win.validTo),
    scheduleId,
    validFrom: win.validFrom,
    validTo: win.validTo,
    requiresApproval: duracion === 'mes'
  };
};

/** Vencimiento del link = fin de la validez del pase (null si la visita no tiene fecha). */
const inviteExpiresAtOf = (visita, tz = DEFAULT_TZ) => {
  const win = visitPassWindow(visita || {}, tz);
  return win ? new Date(win.validTo) : null;
};

module.exports = {
  MAX_MES_DAYS,
  resolveVisitDuration,
  inviteExpiresAtOf
};
