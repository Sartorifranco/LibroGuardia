'use strict';

/**
 * Transformaciones puras modelo Firestore actual → entidades del snapshot
 * (contrato: lib/accessEngine/snapshotSchema.js). Sin I/O: las usa compiler.js
 * y se prueban sueltas.
 *
 * Mapeo (ver PARITY.md y README.md de esta carpeta):
 *  - people.allowedDoorIds = el conjunto de puertas de la persona (D). Igual que
 *    hoy, la lista sola NO habilita: hace falta una base de tiempo (autorización
 *    permanente, nómina con turno, Sistemas, citación, rango o visita).
 *  - authorizations permanentes → puertas directas con horario `sch_auto_<hash>`
 *    (días + ventana, tolerancia 15/15); sin días ni ventana → 24x7.
 *  - nómina (personalMaster source 'nomina'): Sistemas → D en 24x7; área con
 *    citación obligatoria → requiresGrant + D en 24x7 (solo definen puertas) y la
 *    citación del día es un grant '*' con tolerancia 30/15; resto → D en 24x7
 *    restringido por `shiftScheduleId` (turno, tolerancia 30/15) o `sch_sin_turno`.
 *  - citación → grant del día (ventana ±15, la política no estricta la abre a
 *    todo el día con aviso); rango (visita/temporal) → un grant por día del rango
 *    dentro de la ventana D-1..D+7 (00:00 a 23:59:59.999 local).
 *  - visitas → pases con la ventana de su duración (visitPassWindow).
 */

const { hashCredential, credentialKeyId, DEFAULT_POLICY } = require('../accessEngine/snapshotSchema');
const { normalizeDni } = require('../normalize');
const { normalizeAllowedDoorIds } = require('../doorAccess');
const { isCitacionRequiredArea, isSistemasArea } = require('../centroCostoGroups');
const { resolveShiftSchedule } = require('../shiftParser');
const { sha256Hex, canonicalJson } = require('./canonical');
const { toSnapshotSchedule, toSnapshotGroups, toSnapshotHolidays } = require('../accessModel');

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
const BUCKETS = 64;
const WINDOW_BEFORE_DAYS = 1;
const WINDOW_AFTER_DAYS = 7;
const PERMANENT_TOLERANCE_MIN = 15;       // lib/accessValidation.js TOLERANCIA_MINUTOS
const CITACION_TOLERANCE_MIN = 15;
const SHIFT_EARLY_MIN = 30;               // lib/accessNominaMessages.js SHIFT_EARLY_MINUTES
const SHIFT_LATE_MIN = 15;                // lib/accessNominaMessages.js SHIFT_LATE_MINUTES
const VISITA_EARLY_MS = 2 * 60 * 60 * 1000; // lib/visitasAccess.js EARLY_MS
const VISITA_HORAS_EARLY_MS = 15 * 60 * 1000;
const VISITA_DURACIONES = ['un_ingreso', 'horas', 'dia', 'mes'];
const NO_SHIFT_SCHEDULE = Object.freeze({ id: 'sch_sin_turno', intervals: [] });
const RANGE_TYPES = new Set(['visita', 'visit', 'temporal']);
const PASS_STATES = new Set(['pendiente', 'autorizada', 'ingreso_registrado', 'egreso_registrado']);
const PASS_REVOKED_STATES = new Set(['cancelada', 'rechazada', 'revocada']);
const DAY_CODES = { Do: 0, Lu: 1, Ma: 2, Mi: 3, Ju: 4, Vi: 5, Sa: 6 };
/** Permisos que hacen de un usuario un operador de guardia (chunk `operators`). */
const GUARD_PERMISSIONS = [
  'entries.create',
  'guard.doors.panel',
  'monitoring.doors.panel',
  'access.manual_open',
  'access.manual_override',
  'access.exceptional_entry',
  'puertas.estanco.forzar'
];

// ───────────────────────────── Tiempo ─────────────────────────────────

/** ms | Date | Firestore Timestamp | {_seconds} | ISO → ms o null. */
const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'object') {
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    const s = v._seconds ?? v.seconds;
    if (Number.isFinite(Number(s))) return Number(s) * 1000 + Math.floor(Number(v._nanoseconds ?? v.nanoseconds ?? 0) / 1e6);
    return null;
  }
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

const partsFormatters = new Map();
const zoneParts = (ms, tz) => {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    partsFormatters.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return p;
};

/** 'YYYY-MM-DD' local de un instante. */
const ymdOf = (ms, tz = DEFAULT_TZ) => {
  const p = zoneParts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
};

const offsetMs = (ms, tz) => {
  const p = zoneParts(ms, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
};

/** Instante (ms) de la hora local `hhmm` del día `ymd` en `tz`. '24:00' = medianoche siguiente. */
const localToMs = (ymd, hhmm = '00:00', tz = DEFAULT_TZ) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0);
  let t = guess - offsetMs(guess, tz);
  const off2 = offsetMs(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
};

const addDays = (ymd, n) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

const dayStartMs = (ymd, tz) => localToMs(ymd, '00:00', tz);
const dayEndMs = (ymd, tz) => localToMs(addDays(ymd, 1), '00:00', tz) - 1;

/** Días de la ventana de grants (D-1 … D+7) para `today` ('YYYY-MM-DD'). */
const windowDays = (today) => {
  const out = [];
  for (let i = -WINDOW_BEFORE_DAYS; i <= WINDOW_AFTER_DAYS; i += 1) out.push(addDays(today, i));
  return out;
};

const grantsChunkName = (ymd) => `grants-${String(ymd).replace(/-/g, '')}`;
const chunkDay = (name) => {
  const m = /^grants-(\d{4})(\d{2})(\d{2})$/.exec(String(name));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// ───────────────────────────── Buckets ────────────────────────────────

/** Bucket estable de una persona: sha256(personId) % 64. */
const bucketOf = (personId) => parseInt(sha256Hex(String(personId)).slice(0, 8), 16) % BUCKETS;
const bucketChunkName = (bucket) => `ch-${String(bucket).padStart(2, '0')}`;
const chunkNameForPerson = (personId) => bucketChunkName(bucketOf(personId));

// ───────────────────────────── Horarios ───────────────────────────────

const normTime = (value) => {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
};

const timeWindowOf = (tw) => {
  const from = normTime(tw && tw.from);
  const to = normTime(tw && tw.to);
  return from && to ? { from, to } : null;
};

/**
 * Horario autogenerado y deduplicado a partir de días ('Lu'…'Do', 'Fe' se ignora)
 * + ventana. null = sin restricción (24x7).
 */
const buildAutoSchedule = ({ daysOfWeek, timeWindow, before = 0, after = 0 } = {}) => {
  const days = [...new Set((Array.isArray(daysOfWeek) ? daysOfWeek : [])
    .map((c) => DAY_CODES[c] ?? (Number.isInteger(c) && c >= 0 && c <= 6 ? c : null))
    .filter((d) => d !== null))].sort((a, b) => a - b);
  const tw = timeWindowOf(timeWindow);
  const allDays = days.length === 0 || days.length === 7;
  if (!tw && allDays) return null;
  const body = {
    intervals: [{ days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], from: tw ? tw.from : '00:00', to: tw ? tw.to : '24:00' }],
    toleranceBeforeMin: tw ? before : 0,
    toleranceAfterMin: tw ? after : 0
  };
  return { id: `sch_auto_${sha256Hex(canonicalJson(body)).slice(0, 12)}`, ...body };
};

// ───────────────────────────── Personas ───────────────────────────────

const personDni = (p = {}) => normalizeDni(p.dniNormalized || p.dni || p.idNumberNormalized || p.idNumber || '');
const personName = (p = {}) => String(p.nombre || p.name || '').trim() || null;

/** Réplica de attendanceAlerts.employeeRequiresCitacion (ese módulo carga Firestore). */
const employeeRequiresCitacion = (employee = {}) => {
  const centro = employee.centroCosto || employee.company || '';
  if (!isCitacionRequiredArea(centro)) return false;
  const policy = employee.authorizationPolicy || '';
  if (policy === 'citacion' || policy === 'citacion_shift') return true;
  if (employee.requiresCitacion === true) return true;
  const raw = String(employee.conCitacionRaw || '').trim().toUpperCase();
  return raw === 'SI' || raw === 'SÍ';
};

/** ¿La persona entra solo con citación (área de citación obligatoria)? */
const nominaRequiresGrant = (employee) => {
  if (!employee || employee.active === false) return false;
  const centro = employee.centroCosto || employee.company || '';
  if (!isCitacionRequiredArea(centro)) return false;
  return employee.authorizationPolicy !== 'permanent_shift' || employeeRequiresCitacion(employee);
};

const authDate = (auth) => String(auth.appointmentDate || auth.startDate || '').slice(0, 10);
const authDoors = (auth, personDoors) => (auth.allowedDoorIds != null
  ? normalizeAllowedDoorIds(auth.allowedDoorIds)
  : personDoors);

/** Ventana de la citación (lib/accessNominaMessages.resolveAccessTimeWindow). */
const citacionWindow = (auth, shift) => {
  const tw = timeWindowOf(auth.timeWindow);
  if (tw) return tw;
  const at = normTime(auth.appointmentTime);
  if (at) return { from: at, to: normTime(shift && shift.timeWindow && shift.timeWindow.to) || at };
  return null;
};

/**
 * Grant de citación del día.
 * @returns {object|null}
 */
const buildCitacionGrant = ({ auth, personId, personDoors, requiresGrant, shift, tz }) => {
  const date = authDate(auth);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const tw = citacionWindow(auth, requiresGrant ? shift : null);
  const before = requiresGrant ? SHIFT_EARLY_MIN : CITACION_TOLERANCE_MIN;
  const after = requiresGrant ? SHIFT_LATE_MIN : CITACION_TOLERANCE_MIN;
  let from;
  let to;
  if (tw) {
    from = localToMs(date, tw.from, tz) - before * 60000;
    to = localToMs(tw.to <= tw.from ? addDays(date, 1) : date, tw.to, tz) + after * 60000;
  } else {
    from = dayStartMs(date, tz);
    to = dayEndMs(date, tz);
  }
  const doors = requiresGrant ? '*' : authDoors(auth, personDoors);
  if (Array.isArray(doors) && !doors.length) return null;
  return { id: String(auth.id), cardholderId: personId, from, to, doors, source: 'citacion', refId: String(auth.id), day: date };
};

/** Un grant por día del rango que cae en la ventana. */
const buildRangeGrants = ({ auth, personId, personDoors, days, tz }) => {
  const start = String(auth.startDate || '').slice(0, 10);
  const end = String(auth.endDate || auth.startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  const doors = authDoors(auth, personDoors);
  if (!doors.length) return [];
  const source = String(auth.type).toLowerCase() === 'temporal' ? 'temporal' : 'visita';
  return days
    .filter((d) => d >= start && d <= end)
    .map((d) => ({
      id: `${auth.id}@${d.replace(/-/g, '')}`,
      cardholderId: personId,
      from: dayStartMs(d, tz),
      to: dayEndMs(d, tz),
      doors,
      source,
      refId: String(auth.id),
      day: d
    }));
};

const credentialEntry = (type, raw, key, extra = {}) => {
  const valueHash = hashCredential(type, raw, key);
  if (!valueHash) return null;
  return { type, valueHash, status: extra.status || 'active', validFrom: toMs(extra.validFrom), validTo: toMs(extra.validTo) };
};

/**
 * Persona → { cardholder|null, schedules, grants }.
 * `auths`: autorizaciones de la persona (cualquier tipo, ya filtradas por personId).
 * `employee`: ficha de nómina (personalMaster source 'nomina') o null.
 * Persona inexistente o inactiva → cardholder null (la credencial queda desconocida).
 */
const buildPersonEntry = ({ person, auths = [], employee = null, key = null, tz = DEFAULT_TZ, days = [] }) => {
  if (!person || !person.id || person.active === false) return { cardholder: null, schedules: [], grants: [] };
  const personId = String(person.id);
  const D = normalizeAllowedDoorIds(person.allowedDoorIds);
  const schedules = new Map();
  const direct = new Map(); // doorId → Set(scheduleId)
  const addDoors = (doorIds, scheduleId) => {
    for (const doorId of doorIds) {
      if (!direct.has(doorId)) direct.set(doorId, new Set());
      direct.get(doorId).add(scheduleId);
    }
  };
  const useSchedule = (sch) => {
    if (!sch) return '24x7';
    schedules.set(sch.id, sch);
    return sch.id;
  };

  let requiresGrant = person.requiresGrant === true;
  let shiftScheduleId = person.shiftScheduleId || null;
  let shift = null;
  const nomina = employee && employee.active !== false ? employee : null;
  if (nomina) {
    const centro = nomina.centroCosto || nomina.company || '';
    shift = resolveShiftSchedule(nomina);
    if (isSistemasArea(centro)) {
      addDoors(D, '24x7');
    } else if (nominaRequiresGrant(nomina)) {
      requiresGrant = true;
      addDoors(D, '24x7');
    } else if (shift && shift.daysOfWeek && shift.daysOfWeek.length) {
      const sch = buildAutoSchedule({ ...shift, before: SHIFT_EARLY_MIN, after: SHIFT_LATE_MIN });
      if (sch) shiftScheduleId = useSchedule(sch);
      addDoors(D, '24x7');
    } else if (nomina.authorizationPolicy === 'permanent' || nomina.authorizationPolicy === 'permanent_shift') {
      addDoors(D, '24x7');
    } else {
      schedules.set(NO_SHIFT_SCHEDULE.id, NO_SHIFT_SCHEDULE);
      shiftScheduleId = NO_SHIFT_SCHEDULE.id;
      addDoors(D, '24x7');
    }
  }

  const grants = [];
  const daySet = new Set(days);
  for (const auth of auths) {
    if (!auth || auth.active === false) continue;
    if (auth.personId && String(auth.personId) !== personId) continue;
    const type = String(auth.type || '').toLowerCase();
    if (type === 'permanent') {
      const sch = buildAutoSchedule({ daysOfWeek: auth.daysOfWeek, timeWindow: auth.timeWindow, before: PERMANENT_TOLERANCE_MIN, after: PERMANENT_TOLERANCE_MIN });
      addDoors(authDoors(auth, D), useSchedule(sch));
    } else if (type === 'citacion') {
      if (!daySet.has(authDate(auth))) continue;
      const g = buildCitacionGrant({ auth, personId, personDoors: D, requiresGrant, shift, tz });
      if (g) grants.push(g);
    } else if (RANGE_TYPES.has(type)) {
      grants.push(...buildRangeGrants({ auth, personId, personDoors: D, days, tz }));
    }
  }

  // Sin ninguna base de tiempo (ni permanente, ni nómina, ni grants en la
  // ventana): hoy se rechaza con `sin_citacion_para_hoy`. Se modela como
  // citación obligatoria sobre sus puertas → el motor da el mismo código.
  const hasBasis = Boolean(nomina) || direct.size > 0 || grants.length > 0
    || person.accessAll === true || (Array.isArray(person.accessLevels) && person.accessLevels.length > 0);
  if (!hasBasis && D.length) {
    requiresGrant = true;
    addDoors(D, '24x7');
  }

  const credentials = [];
  const dni = personDni(person);
  if (dni) credentials.push(credentialEntry('dni', dni, key));
  for (const c of Array.isArray(person.credentials) ? person.credentials : []) {
    if (!c || !c.type) continue;
    if (c.valueHash && !key) credentials.push({ type: c.type, valueHash: c.valueHash, status: c.status || 'active', validFrom: toMs(c.validFrom), validTo: toMs(c.validTo) });
    else if (c.value != null) {
      const e = credentialEntry(c.type, c.value, key, c);
      if (e) credentials.push(e);
    }
  }

  const doors = [...direct.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([doorId, set]) => [...set].sort().map((scheduleId) => ({ doorId, scheduleId })));

  const cardholder = {
    id: personId,
    status: 'active',
    name: personName(person),
    validFrom: toMs(person.validFrom),
    validTo: toMs(person.validTo),
    doors,
    credentials: credentials.filter(Boolean)
  };
  if (person.accessAll === true) cardholder.accessAll = true;
  if (person.accessAllScheduleId) cardholder.accessAllScheduleId = String(person.accessAllScheduleId);
  if (Array.isArray(person.accessLevels) && person.accessLevels.length) {
    const levels = person.accessLevels.filter((lvl) => {
      if (typeof lvl === 'string') return lvl.trim();
      return Boolean(lvl && (lvl.groupId || lvl.id));
    });
    if (levels.length) cardholder.accessLevels = levels;
  }
  // Turno vacío (sch_sin_turno) + citación obligatoria: el motor diría sin_turno
  // y taparía que hoy no hay citación.
  if (requiresGrant && shiftScheduleId === NO_SHIFT_SCHEDULE.id) shiftScheduleId = null;
  if (shiftScheduleId) cardholder.shiftScheduleId = shiftScheduleId;
  if (requiresGrant) cardholder.requiresGrant = true;

  return {
    cardholder,
    schedules: [...schedules.values()],
    grants: grants.sort((a, b) => a.id.localeCompare(b.id))
  };
};

// ───────────────────────────── Puertas ────────────────────────────────

const side = (zoneFrom, zoneTo) => ({ zoneFrom, zoneTo });

/**
 * Lados por defecto de una puerta del modelo actual (sin áreas): ingreso desde
 * el exterior a planta y egreso a exterior (el egreso de visita cierra el pase,
 * como hoy). En un estanco la exterior da a la esclusa y la interior a planta.
 */
const defaultSides = (door, group) => {
  if (group) {
    const lock = `esclusa:${group.id}`;
    if (door.airlockRole === 'inner' || (door.airlockRole !== 'outer' && group.outerDoorId && group.outerDoorId !== door.id)) {
      return { in: side(lock, 'planta'), out: side('planta', lock) };
    }
    return { in: side('exterior', lock), out: side(lock, 'exterior') };
  }
  return { in: side('exterior', 'planta'), out: side('planta', 'exterior') };
};

const READER_SIDE = { ingreso: 'in', egreso: 'out' };

/** settings/doorsConfig.airlockGroups → interlockGroups (D5: `mode` explícito o 'timed' = comportamiento actual). */
const buildInterlockGroups = (doorsConfig = {}) => {
  const doors = Array.isArray(doorsConfig.doors) ? doorsConfig.doors : [];
  const explicit = Array.isArray(doorsConfig.interlockGroups) ? doorsConfig.interlockGroups : [];
  const legacy = Array.isArray(doorsConfig.airlockGroups) ? doorsConfig.airlockGroups : [];
  const out = new Map();
  for (const g of [...legacy, ...explicit]) {
    if (!g || !g.id || g.enabled === false) continue;
    const doorIds = [...new Set((g.doorIds || []).map(String).filter(Boolean))];
    if (doorIds.length < 2) continue;
    const mode = g.interlockMode === 'sensor' || g.mode === 'sensor' ? 'sensor' : 'timed';
    const outer = g.outerDoorId
      || (doors.find((d) => doorIds.includes(d.id) && d.airlockRole === 'outer') || {}).id
      || doorIds[0];
    const group = {
      id: String(g.id),
      name: g.name ? String(g.name) : undefined,
      doorIds,
      mode,
      timings: {
        outerCloseDelayMs: Number(g.outerCloseDelayMs ?? g.timings?.outerCloseDelayMs) || 5000,
        interDoorDelayMs: Number(g.interDoorDelayMs ?? g.timings?.interDoorDelayMs) || 2000,
        transitTimeoutMs: Number(g.transitTimeoutMs ?? g.timings?.transitTimeoutMs) || 120000
      }
    };
    if (mode === 'timed' || g.outerDoorId) group.outerDoorId = String(outer);
    out.set(group.id, group);
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
};

/** Salida física sin secretos (bridgeSecret / httpAuthToken viajan en fase 2 cifrados). */
const outputOf = (door) => {
  const dev = door.device || {};
  const out = {
    driver: dev.driver || 'sr201',
    host: dev.host || undefined,
    port: Number(dev.port) || undefined,
    channel: Number(dev.channel) || undefined,
    httpUrl: dev.httpUrl || undefined,
    httpMethod: dev.httpMethod || undefined,
    relayMode: door.relayMode || undefined,
    pulseMode: door.pulseMode || undefined
  };
  return out;
};

/** Una puerta de settings/doorsConfig → Door del contrato. */
const buildDoor = (door, groupByDoor) => {
  const id = String(door.id);
  const group = groupByDoor.get(id) || null;
  const sides = door.sides && typeof door.sides === 'object' ? door.sides : defaultSides(door, group);
  const readers = (Array.isArray(door.readers) ? door.readers : [])
    .filter((r) => r && r.id && READER_SIDE[r.direction] && !r.side)
    .map((r) => ({ id: String(r.id), side: READER_SIDE[r.direction] }))
    .concat((Array.isArray(door.readers) ? door.readers : [])
      .filter((r) => r && r.id && (r.side === 'in' || r.side === 'out'))
      .map((r) => ({ id: String(r.id), side: r.side, driver: r.driver || undefined })));
  const out = {
    id,
    name: door.name ? String(door.name) : id,
    enabled: door.active !== false && door.enabled !== false,
    sides,
    readers,
    unlockSec: Number(door.unlockSec) > 0 ? Number(door.unlockSec) : (Number(door.pulseSeconds) > 0 ? Number(door.pulseSeconds) : 3),
    output: outputOf(door)
  };
  if (door.controllerId) out.controllerId = String(door.controllerId);
  if (Number(door.heldOpenSec) > 0) out.heldOpenSec = Number(door.heldOpenSec);
  if (door.requireGuardApproval === true) out.requireGuardApproval = true;
  if (door.notifyGuardOnVisitor === true) out.notifyGuardOnVisitor = true;
  if (door.sensorsRequired === false) out.sensorsRequired = false;
  if (door.lockdown === true) out.lockdown = true;
  if (door.inputs && typeof door.inputs === 'object') out.inputs = door.inputs;
  if (door.repeatWindowSec != null && Number.isFinite(Number(door.repeatWindowSec)) && Number(door.repeatWindowSec) >= 0) {
    out.repeatWindowSec = Math.round(Number(door.repeatWindowSec));
  }
  return out;
};

/**
 * Chunk `doors`. `schedules`: horarios autogenerados (se unen y ordenan).
 * `configuredSchedules` / `configuredGroups` / `configuredHolidays`: catálogo
 * de Firestore (unión; un horario de catálogo pisa al autogenerado si comparten id).
 * `site`: doc sites/{siteId} (tz, policy, areas, holidays opcionales).
 */
const buildDoorsChunk = ({
  siteId,
  site = {},
  doorsConfig = {},
  schedules = [],
  configuredSchedules = [],
  configuredGroups = [],
  configuredHolidays = []
} = {}) => {
  const tz = site.tz || (site.policy && site.policy.tz) || DEFAULT_TZ;
  const interlockGroups = buildInterlockGroups(doorsConfig);
  // Solo para defaultSides (primer grupo de cada puerta). Una puerta puede estar en varios
  // estancos: la lista completa viaja en `interlockGroups` y el motor los evalúa todos.
  const groupByDoor = new Map();
  for (const g of interlockGroups) for (const d of g.doorIds) if (!groupByDoor.has(d)) groupByDoor.set(d, g);
  const doors = (Array.isArray(doorsConfig.doors) ? doorsConfig.doors : [])
    .filter((d) => d && d.id)
    .map((d) => buildDoor(d, groupByDoor))
    .sort((a, b) => a.id.localeCompare(b.id));
  const areaIds = new Set(['exterior', 'planta']);
  for (const g of interlockGroups) areaIds.add(`esclusa:${g.id}`);
  for (const d of doors) {
    if (Array.isArray(d.sides)) continue;
    for (const s of Object.values(d.sides || {})) {
      if (s && s.zoneFrom) areaIds.add(s.zoneFrom);
      if (s && s.zoneTo) areaIds.add(s.zoneTo);
    }
  }
  const siteAreas = new Map((Array.isArray(site.areas) ? site.areas : []).filter((a) => a && a.id).map((a) => [String(a.id), a]));
  const areas = [...new Set([...areaIds, ...siteAreas.keys()])].sort().map((id) => {
    const src = siteAreas.get(id) || {};
    const area = { id };
    const name = String(src.name || '').trim();
    if (name) area.name = name.slice(0, 80);
    if (id === 'exterior' || src.exterior === true) area.exterior = true;
    return area;
  });
  const schedMap = new Map();
  const putSchedule = (s, overwrite = false) => {
    if (!s || !s.id) return;
    if (!overwrite && schedMap.has(s.id)) return;
    schedMap.set(s.id, { ...s });
  };
  putSchedule({ id: '24x7', name: 'Siempre', always: true, builtin: true });
  putSchedule(NO_SHIFT_SCHEDULE);
  for (const s of [...(Array.isArray(site.schedules) ? site.schedules : []), ...schedules]) putSchedule(s);
  for (const raw of configuredSchedules) {
    const shaped = toSnapshotSchedule(raw && raw.id ? raw : null);
    if (shaped) putSchedule(shaped, true);
  }
  const repeatRaw = Number(site.policy && site.policy.repeatWindowSec);
  const policy = {
    tz,
    citacionWindowStrict: Boolean(site.policy && site.policy.citacionWindowStrict),
    apbMode: (site.policy && site.policy.apbMode) || 'soft',
    apbResetMin: Number(site.policy && site.policy.apbResetMin) || 0,
    repeatWindowSec: Number.isFinite(repeatRaw) && repeatRaw >= 0
      ? Math.round(repeatRaw)
      : DEFAULT_POLICY.repeatWindowSec
  };
  return {
    site: { id: siteId, name: site.name || undefined, tz },
    policy,
    doors,
    interlockGroups,
    areas,
    schedules: [...schedMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    holidays: toSnapshotHolidays([
      ...(Array.isArray(site.holidays) ? site.holidays : []),
      ...configuredHolidays
    ]),
    accessGroups: toSnapshotGroups(configuredGroups)
  };
};

// ───────────────────────────── Visitas ────────────────────────────────

/** Id del pase (= contenido del QR): passCode opaco; visitas viejas usan qrId o el id del doc. */
const passIdOf = (visita) => String(visita.passCode || visita.qrId || visita.id);

/**
 * Ventana de validez de una visita según `duracion` (docs/VISITAS-DISENO.md §3.0).
 * Sin `duracion` = 'un_ingreso' (visitas anteriores).
 *  - un_ingreso: esperada − 2 h → validoHasta (mismo día) o fin del día; maxUses 1.
 *  - horas: esperada − 15 min → validoHasta (mismo día).
 *  - dia: 00:00 → 23:59:59.999 del día.
 *  - mes: 00:00 del día de inicio → 23:59:59.999 del día de validoHasta; scheduleId opcional.
 * @returns {{duracion:string, validFrom:number, validTo:number, maxUses:number|null, scheduleId:string|null}|null}
 */
const visitPassWindow = (visita, tz = DEFAULT_TZ) => {
  const expected = toMs(visita && visita.fechaHoraEsperada);
  if (expected == null) return null;
  const duracion = VISITA_DURACIONES.includes(visita.duracion) ? visita.duracion : 'un_ingreso';
  const day = ymdOf(expected, tz);
  const startOfDay = dayStartMs(day, tz);
  const endOfDay = dayEndMs(day, tz);
  const until = toMs(visita.validoHasta);
  const untilSameDay = until != null && ymdOf(until, tz) === day && until > expected ? until : null;
  const out = { duracion, maxUses: null, scheduleId: null };
  if (duracion === 'horas') {
    return { ...out, validFrom: expected - VISITA_HORAS_EARLY_MS, validTo: untilSameDay ?? endOfDay };
  }
  if (duracion === 'dia') return { ...out, validFrom: startOfDay, validTo: endOfDay };
  if (duracion === 'mes') {
    const validTo = until != null && until > expected ? dayEndMs(ymdOf(until, tz), tz) : endOfDay;
    const scheduleId = visita.scheduleId ? String(visita.scheduleId) : null;
    return { ...out, validFrom: startOfDay, validTo, scheduleId };
  }
  return { ...out, validFrom: expected - VISITA_EARLY_MS, validTo: untilSameDay ?? endOfDay, maxUses: 1 };
};

/**
 * Visita → { pass|null, revoked|null, revokedPrevious[] } con la ventana de visitPassWindow.
 * Pendientes de aprobación no generan pase.
 * `revokedPrevious`: códigos reemplazados al editar la visita (ya no sirven).
 * maxUses solo en 'un_ingreso'; el egreso no consume usos.
 */
const buildPass = (visita, { key = null, tz = DEFAULT_TZ } = {}) => {
  if (!visita || !visita.id) return { pass: null, revoked: null, revokedPrevious: [] };
  const estado = visita.estado || 'pendiente';
  const id = passIdOf(visita);
  const revokedPrevious = (Array.isArray(visita.previousPassCodes) ? visita.previousPassCodes : [])
    .map(String)
    .filter((code) => code && code !== id)
    .map((code) => `pass:${code}`);
  if (PASS_REVOKED_STATES.has(estado)) return { pass: null, revoked: `pass:${id}`, revokedPrevious };
  if (!PASS_STATES.has(estado)) return { pass: null, revoked: null, revokedPrevious };
  const win = visitPassWindow(visita, tz);
  if (!win) return { pass: null, revoked: null, revokedPrevious };
  const dni = normalizeDni(visita.dniVisitanteNormalized || visita.dniVisitante || '');
  const pass = {
    id,
    visitaId: String(visita.id),
    name: String(visita.nombreVisitante || '').trim() || undefined,
    doors: normalizeAllowedDoorIds(visita.allowedDoorIds),
    validFrom: win.validFrom,
    validTo: win.validTo,
    status: estado
  };
  if (visita.duracion) pass.duracion = win.duracion;
  // 1b: el cartel del guardia muestra a quién visita.
  const hostName = String(visita.createdByNombre || '').trim();
  const hostCompany = String(visita.empresaNombre || '').trim();
  const destination = String(visita.destinoNombre || '').trim();
  if (hostName) pass.hostName = hostName.slice(0, 120);
  if (hostCompany) pass.hostCompany = hostCompany.slice(0, 120);
  if (destination) pass.destination = destination.slice(0, 120);
  if (win.maxUses != null) pass.maxUses = win.maxUses;
  if (win.scheduleId) pass.scheduleId = win.scheduleId;
  if (dni) {
    if (key) pass.dniHash = hashCredential('dni', dni, key);
    else pass.dni = dni;
  }
  if (visita.personId) pass.cardholderId = String(visita.personId);
  return { pass, revoked: null, revokedPrevious };
};

// ───────────────────────────── Operadores ─────────────────────────────

const isTechnicalUser = (id, user) => String(user.username || id || '').toLowerCase().startsWith('kiosk.')
  || String(user.role || '') === 'kiosk_puerta';

/**
 * users + plantillas de rol → operadores de guardia (auth offline del hub, D6).
 * `roleTemplates`: { roleId: permissions[] } (DEFAULT_ROLE_PERMISSIONS + roles de Firestore).
 */
const buildOperators = (users = [], roleTemplates = {}) => users
  .filter((u) => u && u.active !== false && typeof u.password === 'string' && u.password.startsWith('$2'))
  .filter((u) => !isTechnicalUser(u.id, u))
  .map((u) => {
    const rolePerms = Array.isArray(roleTemplates[u.role]) ? roleTemplates[u.role] : [];
    const perms = [...new Set([...rolePerms, ...(Array.isArray(u.permissions) ? u.permissions : [])])].sort();
    return { u, perms };
  })
  .filter(({ perms }) => perms.some((p) => GUARD_PERMISSIONS.includes(p)))
  .map(({ u, perms }) => ({
    username: String(u.username || u.id),
    hash: u.password,
    passwordVersion: Number(u.passwordVersion) >= 1 ? Math.floor(Number(u.passwordVersion)) : 1,
    perms,
    posts: Array.isArray(u.posts) ? u.posts.map(String) : (Array.isArray(u.guardPosts) ? u.guardPosts.map(String) : []),
    role: u.role || undefined,
    name: u.nombre || undefined,
    mustChangePassword: u.mustChangePassword === true ? true : undefined
  }))
  .sort((a, b) => a.username.localeCompare(b.username));

const buildSecretsChunk = (key) => (key ? {
  secrets: { credentialKey: String(key), keyId: credentialKeyId(key), alg: 'HMAC-SHA256' }
} : null);

module.exports = {
  DEFAULT_TZ,
  BUCKETS,
  NO_SHIFT_SCHEDULE,
  GUARD_PERMISSIONS,
  toMs,
  ymdOf,
  localToMs,
  addDays,
  dayStartMs,
  dayEndMs,
  windowDays,
  grantsChunkName,
  chunkDay,
  bucketOf,
  bucketChunkName,
  chunkNameForPerson,
  buildAutoSchedule,
  buildPersonEntry,
  buildCitacionGrant,
  buildRangeGrants,
  buildInterlockGroups,
  buildDoor,
  buildDoorsChunk,
  VISITA_DURACIONES,
  visitPassWindow,
  buildPass,
  buildOperators,
  buildSecretsChunk,
  nominaRequiresGrant,
  personDni
};
