'use strict';

/**
 * Grupos de acceso, horarios y feriados (fuente de verdad en Firestore).
 * Puro: no lee la base. Lo usan las rutas admin y el compilador.
 *
 * Horario Siempre = id `24x7` (el motor lo trata como siempre válido).
 * Grupo reservado `grp_total` = todas las puertas; lo emite el compilador.
 */

const ALWAYS_SCHEDULE_ID = '24x7';
const TOTAL_GROUP_ID = 'grp_total';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const CODE_TO_DAY = { Do: 0, Lu: 1, Ma: 2, Mi: 3, Ju: 4, Vi: 5, Sa: 6 };
const DAY_SHORT = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const RESERVED_SCHEDULE_IDS = new Set([ALWAYS_SCHEDULE_ID, 'sch_sin_turno']);

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const hmLabel = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return String(hhmm || '');
  const h = String(Number(m[1]));
  return m[2] === '00' ? h : `${h}:${m[2]}`;
};

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const asWeekday = (value) => {
  if (Number.isInteger(value) && value >= 0 && value <= 6) return value;
  if (CODE_TO_DAY[value] != null) return CODE_TO_DAY[value];
  return null;
};

const joinNames = (names) => {
  const list = (names || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} y ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}`;
};

/** L–V, S–D, L, X y V. */
const formatDays = (days) => {
  const set = new Set((Array.isArray(days) ? days : []).map(asWeekday).filter((d) => d != null));
  if (!set.size) return '';
  if (set.size === 7) return 'todos los días';
  const present = DAY_ORDER.filter((d) => set.has(d));
  const ranges = [];
  let start = present[0];
  let prev = present[0];
  const idx = (d) => DAY_ORDER.indexOf(d);
  for (let i = 1; i <= present.length; i += 1) {
    const d = present[i];
    if (d != null && idx(d) === idx(prev) + 1) {
      prev = d;
      continue;
    }
    ranges.push(start === prev ? DAY_SHORT[start] : `${DAY_SHORT[start]}–${DAY_SHORT[prev]}`);
    start = d;
    prev = d;
  }
  return ranges.join(', ');
};

const formatInterval = (iv) => {
  if (!iv) return '';
  const days = formatDays(iv.days);
  const from = hmLabel(iv.from);
  const to = hmLabel(iv.to);
  const a = minutesOf(iv.from);
  const b = minutesOf(iv.to);
  const overnight = a != null && b != null && b <= a;
  const span = overnight ? `${from} a ${to} (pasa de día)` : `${from} a ${to}`;
  return days ? `${days} ${span}` : span;
};

const formatSchedulePhrase = (schedule) => {
  if (!schedule || schedule.always === true || schedule.id === ALWAYS_SCHEDULE_ID) return 'todo el día';
  const parts = (Array.isArray(schedule.intervals) ? schedule.intervals : []).map(formatInterval).filter(Boolean);
  let text = parts.join(' y ') || 'sin franja';
  const before = Number(schedule.toleranceBeforeMin) || 0;
  const after = Number(schedule.toleranceAfterMin) || 0;
  if (before || after) text += ` (${before} min antes, ${after} min después)`;
  return text;
};

const doorPhrase = (doors, doorNamesById) => {
  if (doors === '*') return 'todas las puertas, también las nuevas';
  const ids = Array.isArray(doors) ? doors : [];
  const names = ids.map((id) => {
    const key = typeof id === 'string' ? id : (id && (id.doorId || id.id));
    return (doorNamesById && doorNamesById.get(key)) || key;
  }).filter(Boolean);
  return joinNames(names) || 'ninguna puerta';
};

/**
 * Frases cortas de por qué la persona puede entrar.
 * @returns {string[]}
 */
const explainAccess = ({
  accessLevels = [],
  accessAll = false,
  allowedDoorIds = [],
  groupsById = new Map(),
  schedulesById = new Map(),
  doorNamesById = new Map(),
  auths = [],
  citedToday = false,
  needsCitation = false,
  shift = null
} = {}) => {
  const lines = [];
  const scheduleOf = (id) => {
    if (!id || id === ALWAYS_SCHEDULE_ID) return { id: ALWAYS_SCHEDULE_ID, always: true, name: 'Siempre' };
    return schedulesById.get(id) || null;
  };

  for (const gid of accessLevels) {
    const group = groupsById.get(gid);
    if (!group) {
      lines.push('Tiene un grupo que ya no existe.');
      continue;
    }
    const sch = scheduleOf(group.scheduleId);
    const when = sch ? formatSchedulePhrase(sch) : 'horario desconocido';
    let line = `Grupo ${group.name || gid}: ${when} en ${doorPhrase(group.doors, doorNamesById)}`;
    if (sch && sch.holidayBehavior === 'deny') line += '. Los feriados no entra';
    else if (sch && sch.holidayBehavior === 'allow') line += '. Los feriados entra igual';
    lines.push(line);
  }

  if (accessAll) {
    lines.push('Acceso total: todas las puertas, también las que se agreguen después.');
  }

  for (const auth of auths) {
    if (!auth || auth.active === false) continue;
    if (String(auth.type || '').toLowerCase() !== 'permanent') continue;
    const hasWindow = Boolean(auth.timeWindow && auth.timeWindow.from && auth.timeWindow.to);
    const hasDays = Array.isArray(auth.daysOfWeek) && auth.daysOfWeek.length;
    let when = 'todo el día';
    if (hasWindow) {
      when = formatSchedulePhrase({
        intervals: [{ days: auth.daysOfWeek, from: auth.timeWindow.from, to: auth.timeWindow.to }]
      });
    } else if (hasDays) {
      when = `${formatDays(auth.daysOfWeek)} todo el día`;
    }
    const doors = Array.isArray(auth.allowedDoorIds) && auth.allowedDoorIds.length
      ? auth.allowedDoorIds
      : allowedDoorIds;
    lines.push(`Autorización permanente: ${when} en ${doorPhrase(doors, doorNamesById)}`);
  }

  if (shift && (shift.daysOfWeek || shift.timeWindow)) {
    const when = formatSchedulePhrase({
      intervals: [{
        days: shift.daysOfWeek,
        from: shift.timeWindow && shift.timeWindow.from,
        to: shift.timeWindow && shift.timeWindow.to
      }]
    });
    lines.push(`Turno: ${when}`);
  }

  if (Array.isArray(allowedDoorIds) && allowedDoorIds.length) {
    const label = allowedDoorIds.length === 1 ? 'Puerta asignada directamente' : 'Puertas asignadas directamente';
    lines.push(`${label}: ${doorPhrase(allowedDoorIds, doorNamesById)}`);
  }

  if (citedToday) lines.push('Citado hoy');
  else if (needsCitation) lines.push('Hoy no está citado');

  if (!lines.length) lines.push('Por ahora no tiene un grupo ni una puerta asignada.');
  return lines;
};

const sanitizeIntervals = (raw) => {
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, message: 'Agregá al menos una franja horaria.' };
  }
  if (raw.length > 12) return { ok: false, message: 'Hay demasiadas franjas.' };
  const intervals = [];
  for (const iv of raw) {
    const days = [...new Set((Array.isArray(iv && iv.days) ? iv.days : []).map(asWeekday).filter((d) => d != null))]
      .sort((a, b) => a - b);
    if (!days.length) return { ok: false, message: 'Cada franja tiene que tener al menos un día.' };
    const from = String(iv.from || '').trim();
    const to = String(iv.to || '').trim();
    if (!HHMM.test(from) || !HHMM.test(to)) {
      return { ok: false, message: 'El horario tiene que ser hora y minutos, por ejemplo 08:00.' };
    }
    if (from === to) return { ok: false, message: 'La hora de inicio y la de fin no pueden ser iguales.' };
    intervals.push({ days, from, to });
  }
  return { ok: true, intervals };
};

const sanitizeScheduleInput = (body = {}) => {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) return { ok: false, message: 'El horario tiene que tener un nombre (hasta 80 letras).' };
  const parsed = sanitizeIntervals(body.intervals);
  if (!parsed.ok) return parsed;
  const holidayBehavior = body.holidayBehavior === 'allow' ? 'allow' : 'deny';
  return {
    ok: true,
    value: {
      name,
      intervals: parsed.intervals,
      toleranceBeforeMin: clampInt(body.toleranceBeforeMin, 0, 240, 0),
      toleranceAfterMin: clampInt(body.toleranceAfterMin, 0, 240, 0),
      holidayBehavior
    }
  };
};

const isReservedScheduleId = (id) => RESERVED_SCHEDULE_IDS.has(id) || String(id || '').startsWith('sch_auto_');

const toSnapshotSchedule = (raw) => {
  if (!raw || !raw.id || isReservedScheduleId(String(raw.id))) return null;
  const parsed = sanitizeIntervals(raw.intervals);
  if (!parsed.ok) return null;
  const out = {
    id: String(raw.id),
    intervals: parsed.intervals,
    toleranceBeforeMin: clampInt(raw.toleranceBeforeMin, 0, 240, 0),
    toleranceAfterMin: clampInt(raw.toleranceAfterMin, 0, 240, 0),
    catalog: true
  };
  if (raw.name) out.name = String(raw.name);
  if (raw.holidayBehavior === 'deny' || raw.holidayBehavior === 'allow' || raw.holidayBehavior === 'ignore') {
    out.holidayBehavior = raw.holidayBehavior;
  }
  return out;
};

const toSnapshotGroups = (rawGroups = []) => {
  const map = new Map();
  map.set(TOTAL_GROUP_ID, {
    id: TOTAL_GROUP_ID,
    name: 'Todas las puertas',
    doors: '*',
    scheduleId: ALWAYS_SCHEDULE_ID
  });
  for (const raw of rawGroups) {
    if (!raw || !raw.id || String(raw.id) === TOTAL_GROUP_ID) continue;
    const id = String(raw.id);
    const doors = raw.doors === '*' || raw.allDoors === true
      ? '*'
      : [...new Set((Array.isArray(raw.doors) ? raw.doors : [])
        .map((d) => (typeof d === 'string' ? d : (d && (d.doorId || d.id))))
        .map((d) => String(d || '').trim())
        .filter(Boolean))];
    const group = {
      id,
      doors: doors === '*' ? '*' : doors,
      scheduleId: raw.scheduleId ? String(raw.scheduleId) : ALWAYS_SCHEDULE_ID
    };
    if (raw.name) group.name = String(raw.name);
    map.set(id, group);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
};

const toSnapshotHolidays = (items = []) => {
  const map = new Map();
  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      if (!YMD.test(item)) continue;
      map.set(`|${item}`, { date: item });
      continue;
    }
    const date = String(item.date || '');
    if (!YMD.test(date)) continue;
    const row = { date };
    if (item.name) row.name = String(item.name).slice(0, 80);
    if (item.setId) row.setId = String(item.setId);
    map.set(`${row.setId || ''}|${date}`, row);
  }
  return [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.setId || '').localeCompare(String(b.setId || '')));
};

const sanitizeGroupInput = (body = {}, { doorIds = new Set(), scheduleIds = new Set() } = {}) => {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) return { ok: false, message: 'El grupo tiene que tener un nombre (hasta 80 letras).' };
  const scheduleId = String(body.scheduleId || ALWAYS_SCHEDULE_ID).trim() || ALWAYS_SCHEDULE_ID;
  if (scheduleId !== ALWAYS_SCHEDULE_ID && !scheduleIds.has(scheduleId)) {
    return { ok: false, message: 'Elegí un horario que exista.' };
  }
  const allDoors = body.allDoors === true || body.doors === '*';
  let doors = '*';
  if (!allDoors) {
    const ids = [...new Set((Array.isArray(body.doors) ? body.doors : [])
      .map((d) => String(d || '').trim())
      .filter(Boolean))];
    if (!ids.length) return { ok: false, message: 'Elegí al menos una puerta, o Todas.' };
    const unknown = ids.filter((id) => !doorIds.has(id));
    if (unknown.length) return { ok: false, message: 'Hay una puerta que no existe.' };
    doors = ids.sort();
  }
  return {
    ok: true,
    value: {
      name,
      scheduleId,
      allDoors,
      doors
    }
  };
};

const sanitizeHolidayList = (year, dates) => {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    return { ok: false, message: 'El año no es válido.' };
  }
  if (!Array.isArray(dates)) return { ok: false, message: 'La lista de feriados no es válida.' };
  if (dates.length > 80) return { ok: false, message: 'Hay demasiados feriados para un año.' };
  const map = new Map();
  for (const item of dates) {
    const date = String(item && item.date || '').trim();
    const name = String(item && item.name || '').trim().slice(0, 80);
    if (!YMD.test(date) || !date.startsWith(`${y}-`)) {
      return { ok: false, message: 'Cada feriado tiene que ser una fecha de ese año.' };
    }
    if (!name) return { ok: false, message: 'Cada feriado tiene que tener un nombre.' };
    map.set(date, { date, name });
  }
  return {
    ok: true,
    year: y,
    dates: [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
};

const mergeHolidayLists = (current = [], incoming = []) => {
  const map = new Map();
  for (const item of current) if (item && item.date) map.set(item.date, { date: item.date, name: item.name || item.date });
  for (const item of incoming) if (item && item.date) map.set(item.date, { date: item.date, name: item.name || item.date });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
};

const ymdUtc = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

const utcParts = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
};

/** Martes/miércoles → lunes anterior. Jueves/viernes → lunes siguiente. */
const transferHoliday = (y, m, d) => {
  const p = utcParts(y, m, d);
  if (p.wd === 2) return utcParts(y, m, d - 1);
  if (p.wd === 3) return utcParts(y, m, d - 2);
  if (p.wd === 4) return utcParts(y, m, d + 4);
  if (p.wd === 5) return utcParts(y, m, d + 3);
  return p;
};

/** Domingo de Pascua (algoritmo gregoriano anónimo). */
const easterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y: year, m: month, d: day };
};

const FIXED_HOLIDAYS = [
  [1, 1, 'Año Nuevo'],
  [3, 24, 'Día de la Memoria'],
  [4, 2, 'Día del Veterano y de los Caídos en Malvinas'],
  [5, 1, 'Día del Trabajador'],
  [5, 25, 'Revolución de Mayo'],
  [6, 20, 'Paso a la Inmortalidad del General Belgrano'],
  [7, 9, 'Día de la Independencia'],
  [12, 8, 'Inmaculada Concepción'],
  [12, 25, 'Navidad']
];

const MOVABLE_HOLIDAYS = [
  [6, 17, 'Paso a la Inmortalidad del General Güemes'],
  [8, 17, 'Paso a la Inmortalidad del General San Martín'],
  [10, 12, 'Día del Respeto a la Diversidad Cultural'],
  [11, 20, 'Día de la Soberanía Nacional']
];

/**
 * Feriados nacionales de Argentina para un año (lista fija en el código:
 * inamovibles, trasladables según la ley y Carnaval / Viernes Santo).
 * No incluye puentes que decreta el gobierno cada año: esos se agregan a mano.
 */
const nationalHolidays = (year) => {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return [];
  const rows = [];
  for (const [m, d, name] of FIXED_HOLIDAYS) rows.push({ date: ymdUtc(y, m, d), name });
  for (const [m, d, name] of MOVABLE_HOLIDAYS) {
    const p = transferHoliday(y, m, d);
    rows.push({ date: ymdUtc(p.y, p.m, p.d), name });
  }
  const easter = easterSunday(y);
  const friday = utcParts(easter.y, easter.m, easter.d - 2);
  rows.push({ date: ymdUtc(friday.y, friday.m, friday.d), name: 'Viernes Santo' });
  const monday = utcParts(easter.y, easter.m, easter.d - 48);
  const tuesday = utcParts(easter.y, easter.m, easter.d - 47);
  rows.push({ date: ymdUtc(monday.y, monday.m, monday.d), name: 'Carnaval' });
  rows.push({ date: ymdUtc(tuesday.y, tuesday.m, tuesday.d), name: 'Carnaval' });
  return mergeHolidayLists([], rows);
};

const publicDoors = (doorsConfig = {}) => {
  const airlocks = Array.isArray(doorsConfig.airlockGroups) ? doorsConfig.airlockGroups : [];
  const zoneOf = (door) => {
    const explicit = door.zone || door.zona || door.area || door.areaName;
    if (explicit) return String(explicit);
    if (door.airlockGroupId) {
      const g = airlocks.find((a) => a && a.id === door.airlockGroupId);
      if (g && g.name) return String(g.name);
    }
    return '';
  };
  return (Array.isArray(doorsConfig.doors) ? doorsConfig.doors : [])
    .filter((d) => d && d.id)
    .map((d) => ({
      id: String(d.id),
      name: d.name ? String(d.name) : String(d.id),
      active: d.active !== false && d.enabled !== false,
      zone: zoneOf(d)
    }));
};

const ALWAYS_SCHEDULE_PUBLIC = Object.freeze({
  id: ALWAYS_SCHEDULE_ID,
  name: 'Siempre',
  always: true,
  builtin: true,
  intervals: [],
  toleranceBeforeMin: 0,
  toleranceAfterMin: 0,
  holidayBehavior: 'ignore'
});

module.exports = {
  ALWAYS_SCHEDULE_ID,
  TOTAL_GROUP_ID,
  ALWAYS_SCHEDULE_PUBLIC,
  sanitizeScheduleInput,
  sanitizeGroupInput,
  sanitizeHolidayList,
  mergeHolidayLists,
  nationalHolidays,
  explainAccess,
  formatSchedulePhrase,
  formatDays,
  toSnapshotSchedule,
  toSnapshotGroups,
  toSnapshotHolidays,
  publicDoors,
  isReservedScheduleId
};
