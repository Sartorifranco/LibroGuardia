'use strict';

/**
 * Horarios del motor. Sin librerías: Intl.DateTimeFormat con la tz del sitio.
 * Nunca lee el reloj del sistema: el instante siempre llega como argumento.
 */

const { DEFAULT_TZ } = require('./snapshotSchema');

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

const formatterFor = (tz) => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // h23 (no hour12:false): algunas ICU devuelven "24" a la medianoche.
      hourCycle: 'h23',
      weekday: 'short'
    });
    formatters.set(tz, f);
  }
  return f;
};

/**
 * Partes locales de un instante en una zona.
 * @param {number} atMs
 * @param {string} [tz]
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number,
 *            weekday:number, ymd:string, minuteOfDay:number}}
 */
const localParts = (atMs, tz = DEFAULT_TZ) => {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    throw new TypeError('localParts: atMs debe ser un número finito');
  }
  const parts = {};
  for (const p of formatterFor(tz || DEFAULT_TZ).formatToParts(atMs)) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute,
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute
  };
};

const hhmmToMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 1440 ? v : null;
};

const is24x7 = (schedule) => Boolean(schedule && (schedule.always === true || schedule.id === '24x7'));

/**
 * Evalúa un horario con detalle del motivo.
 *
 * Reglas:
 * - Los minutos se comparan enteros (hh:mm, sin segundos), igual que
 *   `isWithinTimeWindow` de normalize.js: 18:00:59 cuenta como dentro de "hasta 18:00".
 * - `days` es el día en que EMPIEZA el intervalo; `to <= from` cruza medianoche
 *   (22:00–06:00 el lunes cubre lun 22:00 → mar 06:00).
 * - Tolerancias: [from − toleranceBeforeMin, to + toleranceAfterMin], también
 *   a través de la medianoche.
 * - Feriados (fecha local del instante evaluado): 'deny' → cerrado todo el día;
 *   'allow' → abierto todo el día; 'ignore' (default) → como un día normal.
 *
 * @returns {{ok:boolean, reason:null|'fuera_dia'|'fuera_horario'|'feriado'|'sin_intervalos', holiday:boolean}}
 */
const evaluateSchedule = (schedule, atMs, tz, { isHoliday } = {}) => {
  if (!schedule) return { ok: false, reason: 'sin_intervalos', holiday: false };
  if (is24x7(schedule)) return { ok: true, reason: null, holiday: false };
  const zone = schedule.tz || tz || DEFAULT_TZ;
  const lp = localParts(atMs, zone);
  const behavior = schedule.holidayBehavior || 'ignore';
  const holiday = behavior !== 'ignore' && typeof isHoliday === 'function'
    ? Boolean(isHoliday(lp.ymd, schedule.holidaysSetId ?? null)) // null = cualquier calendario
    : false;
  if (holiday && behavior === 'deny') return { ok: false, reason: 'feriado', holiday };
  if (holiday && behavior === 'allow') return { ok: true, reason: null, holiday };

  const intervals = Array.isArray(schedule.intervals) ? schedule.intervals : [];
  if (!intervals.length) return { ok: false, reason: 'sin_intervalos', holiday };
  const before = Math.max(0, Number(schedule.toleranceBeforeMin) || 0);
  const after = Math.max(0, Number(schedule.toleranceAfterMin) || 0);
  const now = lp.minuteOfDay;
  let dayMatch = false;

  for (const iv of intervals) {
    const from = hhmmToMin(iv.from);
    const to = hhmmToMin(iv.to);
    if (from == null || to == null) continue;
    const days = Array.isArray(iv.days) ? iv.days : [];
    const overnight = to <= from;
    const length = overnight ? (1440 - from) + to : to - from;
    // offset = día de inicio relativo a hoy (−1 ayer, 0 hoy, +1 mañana)
    for (const offset of [-1, 0, 1]) {
      const startDay = (lp.weekday + offset + 7) % 7;
      if (!days.includes(startDay)) continue;
      if (offset === 0 || (offset === -1 && overnight)) dayMatch = true;
      const start = from + offset * 1440;
      const end = start + length;
      if (now >= start - before && now <= end + after) {
        return { ok: true, reason: null, holiday };
      }
    }
  }
  return { ok: false, reason: dayMatch ? 'fuera_horario' : 'fuera_dia', holiday };
};

/** true si `atMs` cae dentro del horario. */
const isWithinSchedule = (schedule, atMs, tz, opts = {}) => evaluateSchedule(schedule, atMs, tz, opts).ok;

module.exports = {
  localParts,
  hhmmToMin,
  is24x7,
  evaluateSchedule,
  isWithinSchedule
};
