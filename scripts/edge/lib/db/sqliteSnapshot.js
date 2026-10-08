'use strict';

/**
 * SqliteSnapshot: implementa la interfaz `snap` del motor de decisión
 * (functions/lib/accessEngine) sobre las tablas materializadas por chunkStore.js.
 *
 *   findCredential(type, valueHash) cardholder(id) rightsFor(cardholderId, doorId)
 *   schedule(id) isHoliday(ymd, setId) door(id) interlockGroup(doorId) pass(qrIdOrDni)
 *   isRevoked(id) policy()
 *
 * Todo sincrónico, statements preparados y cacheados. Los objetos de config chicos
 * (puertas, horarios, estancos, política) se cachean en memoria y se invalidan cuando
 * cambia meta('config_version') / meta('config_applied_at') (ver `refresh()`).
 */

const { readMeta } = require('./migrations');
const { DEFAULT_SCHEDULE } = require('./chunkStore');

const BUILTIN_SCHEDULES = {
  [DEFAULT_SCHEDULE]: { id: DEFAULT_SCHEDULE, builtin: true, always: true }
};

function parse(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

class SqliteSnapshot {
  /** @param {import('./driver').Db} db */
  constructor(db) {
    this.db = db;
    this.cacheKey = null;
    this.cache = null;
  }

  /** Invalida los cachés si se aplicó config nueva. Barato (1 lectura de meta). */
  refresh() {
    const key = `${readMeta(this.db, 'config_version')}|${readMeta(this.db, 'config_applied_at')}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.cache = { doors: new Map(), schedules: new Map(), interlockByDoor: null, policy: undefined, site: undefined };
    }
    return this;
  }

  c() {
    if (!this.cache) this.refresh();
    return this.cache;
  }

  version() {
    return Number(readMeta(this.db, 'config_version') || 0);
  }

  /**
   * Credencial por tipo + hash. Si el mismo hash está en más de una persona activa devuelve
   * status 'duplicate' con `cardholderIds` (→ dni_duplicado en el motor).
   * @returns {null|{type,valueHash,cardholderId,status,validFrom,validTo,duplicate?:boolean,cardholderIds?:string[]}}
   */
  findCredential(type, valueHash) {
    const rows = this.db.all(
      'SELECT type, value_hash, cardholder_id, status, valid_from, valid_to FROM credentials WHERE type = ? AND value_hash = ?',
      String(type), String(valueHash)
    );
    if (!rows.length) return null;
    const toCred = (r) => ({
      type: r.type,
      valueHash: r.value_hash,
      cardholderId: r.cardholder_id,
      status: r.status,
      validFrom: r.valid_from,
      validTo: r.valid_to
    });
    if (rows.length === 1) return toCred(rows[0]);
    const active = rows.filter((r) => !r.status || r.status === 'active');
    if (active.length === 1) return toCred(active[0]);
    const base = toCred(active[0] || rows[0]);
    return {
      ...base,
      status: 'duplicate',
      duplicate: true,
      cardholderIds: rows.map((r) => r.cardholder_id).sort()
    };
  }

  /** Persona con sus flags (accessAll, accessLevels, shiftScheduleId, requiresGrant, ...). */
  cardholder(id) {
    const r = this.db.get('SELECT id, status, name, valid_from, valid_to, flags_json FROM cardholders WHERE id = ?', String(id));
    if (!r) return null;
    const flags = parse(r.flags_json, {}) || {};
    return {
      ...flags,
      id: r.id,
      status: r.status,
      name: r.name,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      accessAll: flags.accessAll === true
    };
  }

  /**
   * Derechos materializados de la persona sobre la puerta (directos, grupos, grants).
   * `accessAll` NO aparece acá: el motor lo toma de cardholder(id).accessAll.
   */
  rightsFor(cardholderId, doorId) {
    return this.db
      .all(
        'SELECT door_id, schedule_id, source, ref_id, valid_from, valid_to FROM rights WHERE cardholder_id = ? AND door_id = ?',
        String(cardholderId), String(doorId)
      )
      .map((r) => ({
        doorId: r.door_id,
        scheduleId: r.schedule_id,
        source: r.source,
        refId: r.ref_id,
        validFrom: r.valid_from,
        validTo: r.valid_to
      }));
  }

  schedule(id) {
    if (id === null || id === undefined) return null;
    const key = String(id);
    const cache = this.c().schedules;
    if (!cache.has(key)) {
      const r = this.db.get('SELECT json FROM schedules WHERE id = ?', key);
      cache.set(key, r ? parse(r.json) : (BUILTIN_SCHEDULES[key] || null));
    }
    return cache.get(key);
  }

  /** ymd 'YYYY-MM-DD'. setId null/undefined = cualquier calendario. */
  isHoliday(ymd, setId) {
    if (setId === null || setId === undefined) {
      return Boolean(this.db.get('SELECT 1 AS x FROM holidays WHERE date = ? LIMIT 1', String(ymd)));
    }
    return Boolean(this.db.get('SELECT 1 AS x FROM holidays WHERE date = ? AND set_id = ?', String(ymd), String(setId)));
  }

  door(id) {
    const key = String(id);
    const cache = this.c().doors;
    if (!cache.has(key)) {
      const r = this.db.get('SELECT json FROM doors WHERE id = ?', key);
      cache.set(key, r ? parse(r.json) : null);
    }
    return cache.get(key);
  }

  /** Grupo de estanco que contiene la puerta (o null). Acepta `doorIds` o `doors`. */
  interlockGroup(doorId) {
    const cache = this.c();
    if (!cache.interlockByDoor) {
      const map = new Map();
      for (const r of this.db.all('SELECT json FROM interlocks ORDER BY id')) {
        const g = parse(r.json);
        if (!g) continue;
        for (const d of g.doorIds || g.doors || []) {
          const id = typeof d === 'object' && d ? d.doorId || d.id : d;
          if (id && !map.has(String(id))) map.set(String(id), g);
        }
      }
      cache.interlockByDoor = map;
    }
    return cache.interlockByDoor.get(String(doorId)) || null;
  }

  /** Pase de visita por id de QR o por DNI (si hay varios por DNI, el de validTo más tardío). */
  pass(qrIdOrDni) {
    const key = String(qrIdOrDni);
    const byId = this.db.get('SELECT json FROM passes WHERE id = ?', key);
    if (byId) return parse(byId.json);
    const rows = this.db.all('SELECT json FROM passes WHERE dni = ?', key).map((r) => parse(r.json)).filter(Boolean);
    if (!rows.length) return null;
    const t = (p) => {
      const v = p.validTo;
      const n = typeof v === 'number' ? v : Date.parse(v);
      return Number.isFinite(n) ? n : 0;
    };
    rows.sort((a, b) => t(b) - t(a));
    return rows[0];
  }

  isRevoked(id) {
    return Boolean(this.db.get('SELECT 1 AS x FROM revocations WHERE id = ?', String(id)));
  }

  policy() {
    const cache = this.c();
    if (cache.policy === undefined) cache.policy = parse(readMeta(this.db, 'policy'), {}) || {};
    return cache.policy;
  }

  /** Datos del sitio (tz, etc.) del chunk doors. */
  site() {
    const cache = this.c();
    if (cache.site === undefined) cache.site = parse(readMeta(this.db, 'site'), {}) || {};
    return cache.site;
  }
}

module.exports = { SqliteSnapshot, BUILTIN_SCHEDULES };
