'use strict';

/**
 * Implementación en memoria de la interfaz `SnapLookup` (ver snapshotSchema.js).
 * La usa la nube (vista previa, adaptadores sobre el snapshot) y los tests.
 *
 * Replica a propósito la semántica de la implementación SQLite del edge
 * (scripts/edge/lib/db/chunkStore.js + sqliteSnapshot.js, T3) para que los
 * mismos casos dorados valgan para ambas:
 *  - findCredential → null | credencial | {status:'duplicate', cardholderIds}
 *  - accessAll NO genera filas en rightsFor (el motor lo lee de cardholder().accessAll)
 *  - grupos con doors '*' sí generan filas (todas las puertas conocidas)
 *  - filas de rights: {doorId, scheduleId, source, refId, validFrom, validTo};
 *    directas/grupos con scheduleId default '24x7'; grants con scheduleId null
 *  - revocaciones = passes.revoked (+ clave 'revocations' por compatibilidad)
 *  - feriados por (date, setId); isHoliday(ymd, null) = cualquier calendario
 *  - pass(qrIdOrDni): por id (= contenido del QR) y si no por dni (el de validTo más tardío)
 */

const { DEFAULT_POLICY, SCHEDULE_24X7, chunkLayout } = require('./snapshotSchema');

const DEFAULT_SCHEDULE = '24x7';

/** Igual que asArray de chunkStore.js: array → array; objeto → valores; resto → []. */
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
};

/** ms epoch | ISO | {seconds|_seconds} | Date → ms o null (igual que toMs de chunkStore.js). */
const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') {
    const s = v._seconds ?? v.seconds;
    return Number.isFinite(Number(s)) ? Number(s) * 1000 : null;
  }
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * Junta chunks en un único set de entidades.
 * @param {Object<string, object>|Array<object>} chunks  { nombreChunk: body } o array de bodies
 */
const mergeChunks = (chunks = {}) => {
  const out = {
    site: {},
    policy: { ...DEFAULT_POLICY },
    doors: [],
    interlockGroups: [],
    areas: [],
    schedules: [],
    holidays: [],
    accessGroups: [],
    cardholders: [],
    credentials: [],
    grants: [],
    passes: [],
    revoked: []
  };
  const addBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    for (const [key, value] of Object.entries(body)) {
      if (key === 'policy' && value) out.policy = { ...out.policy, ...value };
      else if (key === 'site' && value) out.site = { ...out.site, ...value };
      else if (key === 'revocations') out.revoked.push(...asArray(value));
      else if (key === 'interlocks') out.interlockGroups.push(...asArray(value));
      else if (key === 'holidays' && value && !Array.isArray(value)) {
        for (const [setId, dates] of Object.entries(value)) {
          for (const date of asArray(dates)) out.holidays.push({ date, setId: setId === 'default' ? '' : setId });
        }
      } else if (Array.isArray(out[key])) out[key].push(...asArray(value));
    }
  };
  if (Array.isArray(chunks)) chunks.forEach(addBody);
  else {
    for (const [name, body] of Object.entries(chunks)) {
      if (chunkLayout(name)) addBody(body);
    }
  }
  return out;
};

/**
 * @param {Object|Array} chunks  ver mergeChunks
 * @returns {import('./snapshotSchema').SnapLookup}
 */
const createMemorySnapshot = (chunks = {}) => {
  const data = mergeChunks(chunks);
  const byId = (list) => new Map(list.filter((x) => x && x.id).map((x) => [String(x.id), x]));

  const doors = byId(data.doors);
  const areas = byId(data.areas);
  const schedules = byId(data.schedules);
  const groups = byId(data.accessGroups);
  const allDoorIds = [...doors.keys()].sort();

  const interlockByDoor = new Map();
  for (const g of data.interlockGroups.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    for (const d of g.doorIds || g.doors || []) {
      const id = typeof d === 'object' && d ? d.doorId || d.id : d;
      if (id && !interlockByDoor.has(String(id))) interlockByDoor.set(String(id), g);
    }
  }

  const holidays = new Set();
  for (const h of data.holidays) {
    if (typeof h === 'string') holidays.add(`|${h}`);
    else if (h && h.date) holidays.add(`${h.setId ?? h.set_id ?? ''}|${h.date}`);
  }
  const holidayDates = new Set([...holidays].map((k) => k.split('|')[1]));

  // Personas y credenciales (anidadas o sueltas). Clave de credencial: type|hash|cardholderId.
  const cardholders = new Map();
  const credentials = new Map();
  const addCred = (c, cardholderId) => {
    const valueHash = c && (c.valueHash ?? c.value_hash);
    if (!c || !c.type || !valueHash || !cardholderId) return;
    const key = `${c.type}|${valueHash}`;
    if (!credentials.has(key)) credentials.set(key, new Map());
    credentials.get(key).set(String(cardholderId), {
      type: c.type,
      valueHash,
      cardholderId: String(cardholderId),
      status: c.status ?? 'active',
      validFrom: toMs(c.validFrom),
      validTo: toMs(c.validTo)
    });
  };
  for (const ch of data.cardholders) {
    if (!ch || !ch.id) continue;
    const { id, status, name, validFrom, validTo, credentials: nested, ...flags } = ch;
    cardholders.set(String(id), {
      ...flags,
      id: String(id),
      status: status ?? 'active',
      name: name ?? null,
      validFrom: toMs(validFrom),
      validTo: toMs(validTo),
      accessAll: flags.accessAll === true
    });
    for (const c of asArray(nested)) addCred(c, id);
  }
  for (const c of data.credentials) addCred(c, c && (c.cardholderId ?? c.cardholder_id));

  // rights materializados (directas + grupos + grants), igual que chunkStore.personRights/applyGrants.
  const rights = new Map(); // `${ch}|${door}` → rows
  const pushRight = (chId, doorId, scheduleId, source, refId, from, to) => {
    const key = `${chId}|${doorId}`;
    if (!rights.has(key)) rights.set(key, []);
    rights.get(key).push({ doorId: String(doorId), scheduleId, source, refId, validFrom: from, validTo: to });
  };
  for (const ch of cardholders.values()) {
    const push = (doorId, scheduleId, source, refId, from, to) =>
      pushRight(ch.id, doorId, scheduleId || DEFAULT_SCHEDULE, source, refId, from, to);
    for (const d of asArray(ch.doors ?? ch.directDoors)) {
      if (typeof d === 'string') push(d, DEFAULT_SCHEDULE, 'direct', null, null, null);
      else if (d && (d.doorId || d.id)) push(d.doorId || d.id, d.scheduleId, 'direct', null, toMs(d.validFrom), toMs(d.validTo));
    }
    for (const doorId of asArray(ch.allowedDoorIds)) push(doorId, DEFAULT_SCHEDULE, 'direct', null, null, null);
    for (const lvl of asArray(ch.accessLevels)) {
      const gid = typeof lvl === 'string' ? lvl : (lvl && (lvl.groupId || lvl.id));
      const g = gid ? groups.get(String(gid)) : null;
      if (!g) continue;
      const from = typeof lvl === 'object' ? toMs(lvl.validFrom) : null;
      const to = typeof lvl === 'object' ? toMs(lvl.validTo) : null;
      const lvlSchedule = typeof lvl === 'object' ? lvl.scheduleId : null;
      const gDoors = g.doors ?? g.doorIds;
      if (gDoors === '*') {
        for (const doorId of allDoorIds) push(doorId, lvlSchedule || g.scheduleId, 'group', String(gid), from, to);
        continue;
      }
      for (const d of asArray(gDoors)) {
        if (typeof d === 'string') push(d, lvlSchedule || g.scheduleId, 'group', String(gid), from, to);
        else if (d && (d.doorId || d.id)) push(d.doorId || d.id, d.scheduleId || lvlSchedule || g.scheduleId, 'group', String(gid), from, to);
      }
    }
  }
  for (const g of data.grants) {
    if (!g || !g.cardholderId) continue;
    let gDoors = g.doors ?? g.doorIds ?? (g.doorId ? [g.doorId] : []);
    if (gDoors === '*') gDoors = allDoorIds;
    for (const d of asArray(gDoors)) {
      const doorId = String(typeof d === 'object' && d ? (d.doorId || d.id) : d);
      pushRight(String(g.cardholderId), doorId, g.scheduleId ?? null, g.source || 'grant',
        g.refId ?? g.id ?? null, toMs(g.from ?? g.validFrom), toMs(g.to ?? g.validTo));
    }
  }

  const passesById = new Map();
  const passesByDni = new Map();
  for (const p of data.passes) {
    const id = p && (p.id ?? p.qrId);
    if (!id) continue;
    passesById.set(String(id), p);
  }
  for (const p of passesById.values()) {
    if (!p.dni) continue;
    const k = String(p.dni);
    if (!passesByDni.has(k)) passesByDni.set(k, []);
    passesByDni.get(k).push(p);
  }

  const revocations = new Set(data.revoked.map((r) => (typeof r === 'string' ? r : r && r.id)).filter(Boolean).map(String));
  const policy = { ...DEFAULT_POLICY, ...data.policy };
  const site = { ...data.site };

  return {
    findCredential(type, valueHash) {
      const rows = [...((credentials.get(`${type}|${valueHash}`) || new Map()).values())];
      if (!rows.length) return null;
      if (rows.length === 1) return { ...rows[0] };
      const active = rows.filter((r) => !r.status || r.status === 'active');
      if (active.length === 1) return { ...active[0] };
      return {
        ...(active[0] || rows[0]),
        status: 'duplicate',
        duplicate: true,
        cardholderIds: rows.map((r) => r.cardholderId).sort()
      };
    },
    cardholder(id) {
      const ch = cardholders.get(String(id));
      return ch ? { ...ch } : null;
    },
    rightsFor(cardholderId, doorId) {
      return (rights.get(`${cardholderId}|${doorId}`) || []).map((r) => ({ ...r }));
    },
    schedule(id) {
      if (id === null || id === undefined) return null;
      return schedules.get(String(id)) || (String(id) === DEFAULT_SCHEDULE ? SCHEDULE_24X7 : null);
    },
    isHoliday(dateYmd, setId) {
      if (setId === null || setId === undefined) return holidayDates.has(String(dateYmd));
      return holidays.has(`${setId}|${dateYmd}`);
    },
    door(id) { return doors.get(String(id)) || null; },
    area(id) { return areas.get(String(id)) || null; },
    interlockGroup(doorId) { return interlockByDoor.get(String(doorId)) || null; },
    pass(qrIdOrDni) {
      const key = String(qrIdOrDni);
      if (passesById.has(key)) return passesById.get(key);
      const rows = (passesByDni.get(key) || []).slice();
      if (!rows.length) return null;
      const t = (p) => {
        const n = toMs(p.validTo);
        return Number.isFinite(n) ? n : 0;
      };
      rows.sort((a, b) => t(b) - t(a));
      return rows[0];
    },
    isRevoked(key) { return revocations.has(String(key)); },
    policy() { return policy; },
    site() { return site; }
  };
};

module.exports = { createMemorySnapshot, mergeChunks, toMs };
