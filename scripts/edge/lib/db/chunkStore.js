'use strict';

/**
 * Chunk store del edge: guarda los chunks del snapshot compilado por la nube
 * (`sites/{s}/compiled/head` + chunks `doors`, `ch-NN`, `grants-YYYYMMDD`, `passes`, `operators`),
 * verifica su hash (sha256 del JSON canónico del cuerpo) y los materializa en las tablas
 * que consulta el motor (ver sqliteSnapshot.js).
 *
 * - `applyHead(head, bodies)` es la entrada principal: todo-o-nada en una transacción,
 *   `configVersion` monotónico (versión menor → { applied:false, reason:'stale' }).
 * - `rights` se materializa SOLO para las puertas de este equipo (`myDoorIds`, o todas en el hub).
 * - `accessAll` (D7) queda como flag de la persona; no se explota en filas de rights.
 * - La firma Ed25519 del head la verifica quien llama (o el hook `verifyHead`).
 */

const crypto = require('crypto');
const { readMeta, writeMeta } = require('./migrations');

const CH_RE = /^ch-\d{2}$/;
const GRANTS_RE = /^grants-\d{8}$/;
const DEFAULT_SCHEDULE = '24x7';

class ChunkHashError extends Error {
  constructor(name, expected, actual) {
    super(`Chunk "${name}": hash ${actual} no coincide con el esperado ${expected}`);
    this.name = 'ChunkHashError';
    this.code = 'CHUNK_HASH_MISMATCH';
    this.chunk = name;
    this.expected = expected;
    this.actual = actual;
  }
}

/** JSON canónico: claves ordenadas, sin espacios, `undefined` omitido (igual que JSON.stringify). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashBody(body) {
  const obj = typeof body === 'string' ? JSON.parse(body) : body;
  return crypto.createHash('sha256').update(canonicalJson(obj), 'utf8').digest('hex');
}

function normHash(h) {
  return h ? String(h).replace(/^sha256:/i, '').toLowerCase() : null;
}

/** ms epoch | ISO | {seconds|_seconds} | Date → ms o null. */
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') {
    const s = v.seconds ?? v._seconds;
    if (s !== undefined) return Number(s) * 1000 + Math.floor(Number(v.nanoseconds ?? v._nanoseconds ?? 0) / 1e6);
    return null;
  }
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

function chunkKind(name) {
  if (name === 'doors') return 'doors';
  if (CH_RE.test(name)) return 'cardholders';
  if (GRANTS_RE.test(name)) return 'grants';
  if (name === 'passes') return 'passes';
  if (name === 'operators') return 'operators';
  return null;
}

/** Orden de aplicación: doors primero (grupos/puertas), después personas, grants y el resto. */
const KIND_ORDER = { doors: 0, cardholders: 1, grants: 2, passes: 3, operators: 4 };

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function json(v) {
  return JSON.stringify(v === undefined ? null : v);
}

class ChunkStore {
  /**
   * @param {import('./driver').Db} db base ya migrada
   * @param {object} [opts]
   * @param {'hub'|'controller'} [opts.role='controller']
   * @param {string[]|null} [opts.myDoorIds] puertas de este equipo. Hub: null = todas.
   * @param {string} [opts.deviceId] controller sin myDoorIds: se derivan de doors.controllerId
   * @param {(head:object)=>boolean} [opts.verifyHead] verificación de firma del head
   * @param {()=>number} [opts.now]
   */
  constructor(db, { role = 'controller', myDoorIds = null, deviceId = null, verifyHead = null, now = () => Date.now() } = {}) {
    this.db = db;
    this.role = role;
    this.fixedDoorIds = Array.isArray(myDoorIds) ? myDoorIds.map(String) : null;
    this.deviceId = deviceId;
    this.verifyHead = verifyHead;
    this.now = now;
  }

  configVersion() {
    return Number(readMeta(this.db, 'config_version') || 0);
  }

  /** ¿Este equipo guarda/aplica el chunk? (el controlador no recibe operadores). */
  isRelevant(name) {
    const kind = chunkKind(name);
    if (!kind) return false;
    if (kind === 'operators') return this.role === 'hub';
    return true;
  }

  /** Set de puertas para materializar rights; null = todas (hub). */
  myDoors() {
    if (this.fixedDoorIds) return new Set(this.fixedDoorIds);
    if (this.role === 'hub') return null;
    if (!this.deviceId) return new Set();
    const set = new Set();
    for (const row of this.db.all('SELECT id, json FROM doors')) {
      const d = JSON.parse(row.json);
      if (d && d.controllerId === this.deviceId) set.add(row.id);
    }
    return set;
  }

  getChunk(name) {
    const row = this.db.get('SELECT name, version, hash, body, verified, applied_hash FROM chunks WHERE name = ?', name);
    if (!row) return null;
    return {
      name: row.name,
      version: row.version,
      hash: row.hash,
      body: JSON.parse(row.body),
      verified: row.verified === 1,
      appliedHash: row.applied_hash
    };
  }

  listChunks() {
    return this.db.all('SELECT name, version, hash, verified, applied_hash FROM chunks ORDER BY name').map((r) => ({
      name: r.name, version: r.version, hash: r.hash, verified: r.verified === 1, appliedHash: r.applied_hash
    }));
  }

  /**
   * Guarda un chunk (sin materializar). Con `expectedHash` verifica y marca verified=1;
   * si no coincide lanza ChunkHashError y no guarda nada.
   */
  storeChunk(name, version, body, { expectedHash = null } = {}) {
    const obj = typeof body === 'string' ? JSON.parse(body) : body;
    const canonical = canonicalJson(obj);
    const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    const expected = normHash(expectedHash);
    if (expected && expected !== hash) throw new ChunkHashError(name, expected, hash);
    this.db.run(
      `INSERT INTO chunks(name, version, hash, body, verified, stored_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET version = excluded.version, hash = excluded.hash, body = excluded.body,
         verified = excluded.verified, stored_at = excluded.stored_at`,
      name, Number(version) || 0, hash, canonical, expected ? 1 : 0, this.now()
    );
    return { name, version: Number(version) || 0, hash, verified: Boolean(expected) };
  }

  /** Recalcula el hash del cuerpo guardado; actualiza y devuelve el flag verified. */
  verifyChunk(name, expectedHash = null) {
    const row = this.db.get('SELECT hash, body FROM chunks WHERE name = ?', name);
    if (!row) return false;
    const actual = hashBody(row.body);
    const expected = normHash(expectedHash) || row.hash;
    const ok = actual === expected && actual === row.hash;
    this.db.run('UPDATE chunks SET verified = ? WHERE name = ?', ok ? 1 : 0, name);
    return ok;
  }

  /** Nombres del head que hay que bajar (hash distinto o no verificado). */
  needsChunks(head) {
    const out = [];
    for (const [name, meta] of Object.entries((head && head.chunks) || {})) {
      if (!this.isRelevant(name)) continue;
      const row = this.db.get('SELECT hash, verified FROM chunks WHERE name = ?', name);
      if (!row || row.hash !== normHash(meta.hash) || row.verified !== 1) out.push(name);
    }
    return out.sort();
  }

  /**
   * Aplica un head completo de forma atómica.
   * @param {{version:number, chunks:Object<string,{v:number,hash:string}>}} head
   * @param {Object<string,object>} [bodies] cuerpos recién bajados; los demás se toman de la tabla chunks
   * @returns {{applied:boolean, reason?:string, version?:number, changed?:string[], removed?:string[], missing?:string[]}}
   */
  applyHead(head, bodies = {}) {
    const version = Number(head && head.version);
    if (!Number.isFinite(version)) return { applied: false, reason: 'invalid_head' };
    if (this.verifyHead && !this.verifyHead(head)) return { applied: false, reason: 'bad_signature' };
    const current = this.configVersion();
    if (version < current) return { applied: false, reason: 'stale', current };
    if (version === current && readMeta(this.db, 'config_head_hash') === hashBody(head.chunks || {})) {
      return { applied: false, reason: 'up_to_date', current };
    }
    const headChunks = Object.entries(head.chunks || {}).filter(([name]) => this.isRelevant(name));

    // Validar fuera de la transacción: cuerpos nuevos contra el hash del head, faltantes.
    const missing = [];
    for (const [name, meta] of headChunks) {
      if (Object.prototype.hasOwnProperty.call(bodies, name)) {
        const actual = hashBody(bodies[name]);
        if (actual !== normHash(meta.hash)) throw new ChunkHashError(name, normHash(meta.hash), actual);
      } else {
        const row = this.db.get('SELECT hash FROM chunks WHERE name = ?', name);
        if (!row || row.hash !== normHash(meta.hash) || !this.verifyChunk(name, meta.hash)) missing.push(name);
      }
    }
    if (missing.length) return { applied: false, reason: 'missing_chunks', missing: missing.sort() };

    return this.db.tx(() => {
      for (const [name, meta] of headChunks) {
        if (Object.prototype.hasOwnProperty.call(bodies, name)) {
          this.storeChunk(name, meta.v ?? version, bodies[name], { expectedHash: meta.hash });
        }
      }
      const inHead = new Set(headChunks.map(([n]) => n));
      const removed = this.db.all('SELECT name FROM chunks WHERE applied_hash IS NOT NULL ORDER BY name')
        .map((r) => r.name).filter((n) => !inHead.has(n));
      for (const name of removed) {
        this.unmaterialize(name);
        this.db.run('DELETE FROM chunks WHERE name = ?', name);
      }
      const changed = headChunks
        .filter(([name, meta]) => {
          const row = this.db.get('SELECT applied_hash FROM chunks WHERE name = ?', name);
          return !row || row.applied_hash !== normHash(meta.hash);
        })
        .map(([name]) => name)
        .sort((a, b) => (KIND_ORDER[chunkKind(a)] - KIND_ORDER[chunkKind(b)]) || a.localeCompare(b));
      for (const name of changed) this.materializeStored(name);
      writeMeta(this.db, 'config_version', version);
      writeMeta(this.db, 'config_head_hash', hashBody(head.chunks || {}));
      writeMeta(this.db, 'config_applied_at', this.now());
      return { applied: true, version, changed, removed };
    });
  }

  /**
   * Aplica un solo chunk (p. ej. un grants del día nuevo). Rechaza versiones viejas:
   * `configVersion` menor al aplicado o versión de chunk menor a la guardada → stale.
   */
  applyChunk(name, body, { version = 0, configVersion = null, expectedHash = null } = {}) {
    if (!chunkKind(name)) return { applied: false, reason: 'unknown_chunk' };
    if (!this.isRelevant(name)) return { applied: false, reason: 'not_relevant' };
    const current = this.configVersion();
    if (configVersion !== null && Number(configVersion) < current) return { applied: false, reason: 'stale', current };
    const prev = this.db.get('SELECT version FROM chunks WHERE name = ?', name);
    if (prev && Number(version) < prev.version) return { applied: false, reason: 'stale', current: prev.version };
    return this.db.tx(() => {
      const stored = this.storeChunk(name, version, body, { expectedHash });
      this.materializeStored(name);
      if (configVersion !== null && Number(configVersion) > current) writeMeta(this.db, 'config_version', Number(configVersion));
      return { applied: true, name, version: stored.version, hash: stored.hash };
    });
  }

  // ---------- materialización (siempre dentro de una transacción) ----------

  materializeStored(name) {
    const row = this.db.get('SELECT hash, body FROM chunks WHERE name = ?', name);
    const body = JSON.parse(row.body);
    switch (chunkKind(name)) {
      case 'doors': this.applyDoors(body); break;
      case 'cardholders': this.applyCardholders(name, body); break;
      case 'grants': this.applyGrants(name, body); break;
      case 'passes': this.applyPasses(name, body); break;
      case 'operators': this.applyOperators(body); break;
      default: break;
    }
    this.db.run('UPDATE chunks SET applied_hash = ? WHERE name = ?', row.hash, name);
  }

  unmaterialize(name) {
    switch (chunkKind(name)) {
      case 'cardholders':
        this.db.run('DELETE FROM rights WHERE chunk = ?', name);
        this.db.run('DELETE FROM credentials WHERE chunk = ?', name);
        this.db.run('DELETE FROM cardholders WHERE chunk = ?', name);
        break;
      case 'grants':
        this.db.run('DELETE FROM rights WHERE chunk = ?', name);
        break;
      case 'passes':
        this.db.run('DELETE FROM passes WHERE chunk = ?', name);
        this.db.run('DELETE FROM revocations');
        break;
      case 'operators':
        if (this.role === 'hub') this.db.run('DELETE FROM operators');
        break;
      default:
        break;
    }
  }

  applyDoors(body) {
    const db = this.db;
    db.run('DELETE FROM doors');
    db.run('DELETE FROM schedules');
    db.run('DELETE FROM holidays');
    db.run('DELETE FROM interlocks');
    db.run('DELETE FROM access_groups');
    for (const d of asArray(body.doors)) {
      if (d && d.id) db.run('INSERT OR REPLACE INTO doors(id, json) VALUES (?, ?)', String(d.id), json(d));
    }
    for (const s of asArray(body.schedules)) {
      if (s && s.id) db.run('INSERT OR REPLACE INTO schedules(id, json) VALUES (?, ?)', String(s.id), json(s));
    }
    // holidays: [{date, setId}] | ['YYYY-MM-DD'] | {setId: ['YYYY-MM-DD', ...]}
    const hol = body.holidays;
    const holRows = [];
    if (Array.isArray(hol)) {
      for (const h of hol) {
        if (typeof h === 'string') holRows.push([h, '']);
        else if (h && h.date) holRows.push([String(h.date), String(h.setId ?? h.set_id ?? '')]);
      }
    } else if (hol && typeof hol === 'object') {
      for (const [setId, dates] of Object.entries(hol)) {
        for (const date of asArray(dates)) holRows.push([String(date), setId === 'default' ? '' : setId]);
      }
    }
    for (const [date, setId] of holRows) db.run('INSERT OR IGNORE INTO holidays(date, set_id) VALUES (?, ?)', date, setId);
    for (const g of asArray(body.interlockGroups ?? body.interlocks)) {
      if (g && g.id) db.run('INSERT OR REPLACE INTO interlocks(id, json) VALUES (?, ?)', String(g.id), json(g));
    }
    for (const g of asArray(body.accessGroups)) {
      if (g && g.id) db.run('INSERT OR REPLACE INTO access_groups(id, json) VALUES (?, ?)', String(g.id), json(g));
    }
    writeMeta(db, 'policy', json(body.policy ?? body.policies ?? {}));
    writeMeta(db, 'site', json(body.site ?? {}));
    // Cambian puertas/grupos → rematerializar rights directos y por grupo de todas las personas.
    this.rebuildPersonRights();
  }

  loadGroups() {
    const groups = new Map();
    for (const row of this.db.all('SELECT id, json FROM access_groups')) groups.set(row.id, JSON.parse(row.json));
    return groups;
  }

  /** Filas de rights (directas y por grupo) de una persona, filtradas por puertas propias. */
  personRights(ch, flags, groups, myDoors, allDoorIds) {
    const out = [];
    const keep = (doorId) => myDoors === null || myDoors.has(doorId);
    const expand = (doors) => (doors === '*' ? (myDoors === null ? allDoorIds() : [...myDoors]) : asArray(doors));
    const push = (doorId, scheduleId, source, refId, from, to) => {
      const id = String(doorId);
      if (keep(id)) out.push([ch.id, id, scheduleId || DEFAULT_SCHEDULE, source, refId, from, to]);
    };
    // Puertas directas: doors [{doorId, scheduleId}] | allowedDoorIds [doorId]
    for (const d of asArray(flags.doors)) {
      if (typeof d === 'string') push(d, DEFAULT_SCHEDULE, 'direct', null, null, null);
      else if (d && (d.doorId || d.id)) push(d.doorId || d.id, d.scheduleId, 'direct', null, toMs(d.validFrom), toMs(d.validTo));
    }
    for (const doorId of asArray(flags.allowedDoorIds)) push(doorId, DEFAULT_SCHEDULE, 'direct', null, null, null);
    // Grupos: accessLevels [groupId | {groupId|id, scheduleId, validFrom, validTo}]
    for (const lvl of asArray(flags.accessLevels)) {
      const gid = typeof lvl === 'string' ? lvl : (lvl && (lvl.groupId || lvl.id));
      if (!gid) continue;
      const g = groups.get(String(gid));
      if (!g) continue;
      const from = typeof lvl === 'object' ? toMs(lvl.validFrom) : null;
      const to = typeof lvl === 'object' ? toMs(lvl.validTo) : null;
      const lvlSchedule = typeof lvl === 'object' ? lvl.scheduleId : null;
      const gDoors = g.doors ?? g.doorIds;
      if (gDoors === '*') {
        for (const doorId of expand('*')) push(doorId, lvlSchedule || g.scheduleId, 'group', String(gid), from, to);
        continue;
      }
      for (const d of asArray(gDoors)) {
        if (typeof d === 'string') push(d, lvlSchedule || g.scheduleId, 'group', String(gid), from, to);
        else if (d && (d.doorId || d.id)) push(d.doorId || d.id, d.scheduleId || lvlSchedule || g.scheduleId, 'group', String(gid), from, to);
      }
    }
    return out;
  }

  insertRights(rows, chunk) {
    const stmt = this.db.cached(
      'INSERT INTO rights(cardholder_id, door_id, schedule_id, source, ref_id, valid_from, valid_to, chunk) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of rows) stmt.run(...r, chunk);
  }

  allDoorIdsFn() {
    let cache = null;
    return () => {
      if (!cache) cache = this.db.all('SELECT id FROM doors ORDER BY id').map((r) => r.id);
      return cache;
    };
  }

  rebuildPersonRights() {
    const db = this.db;
    db.run("DELETE FROM rights WHERE source IN ('direct', 'group')");
    const groups = this.loadGroups();
    const myDoors = this.myDoors();
    const allDoorIds = this.allDoorIdsFn();
    for (const row of db.all('SELECT id, flags_json, chunk FROM cardholders')) {
      const flags = row.flags_json ? JSON.parse(row.flags_json) : {};
      this.insertRights(this.personRights({ id: row.id }, flags, groups, myDoors, allDoorIds), row.chunk);
    }
    // Grants dependen de myDoors (que puede derivar de doors.controllerId): rehacerlos también.
    for (const r of db.all("SELECT name FROM chunks WHERE applied_hash IS NOT NULL AND name LIKE 'grants-%'")) {
      const c = db.get('SELECT body FROM chunks WHERE name = ?', r.name);
      this.applyGrants(r.name, JSON.parse(c.body));
    }
  }

  applyCardholders(name, body) {
    const db = this.db;
    db.run('DELETE FROM rights WHERE chunk = ? AND source IN (\'direct\', \'group\')', name);
    db.run('DELETE FROM credentials WHERE chunk = ?', name);
    db.run('DELETE FROM cardholders WHERE chunk = ?', name);
    const groups = this.loadGroups();
    const myDoors = this.myDoors();
    const allDoorIds = this.allDoorIdsFn();
    const insCh = db.cached(
      'INSERT OR REPLACE INTO cardholders(id, status, name, valid_from, valid_to, flags_json, chunk) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insCred = db.cached(
      'INSERT OR REPLACE INTO credentials(type, value_hash, cardholder_id, status, valid_from, valid_to, chunk) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const credRow = (c, cardholderId) => {
      const type = c.type;
      const valueHash = c.valueHash ?? c.value_hash;
      if (!type || !valueHash || !cardholderId) return;
      insCred.run(String(type), String(valueHash), String(cardholderId), c.status ?? 'active', toMs(c.validFrom), toMs(c.validTo), name);
    };
    for (const ch of asArray(body.cardholders)) {
      if (!ch || !ch.id) continue;
      const {
        id, status, name: chName, validFrom, validTo, credentials, ...flags
      } = ch;
      insCh.run(String(id), status ?? 'active', chName ?? null, toMs(validFrom), toMs(validTo), json(flags), name);
      for (const c of asArray(credentials)) credRow(c, id);
      this.insertRights(this.personRights({ id: String(id) }, flags, groups, myDoors, allDoorIds), name);
    }
    // Credenciales sueltas: [{type, valueHash, cardholderId, ...}]
    for (const c of asArray(body.credentials)) credRow(c, c && (c.cardholderId ?? c.cardholder_id));
  }

  applyGrants(name, body) {
    const db = this.db;
    db.run('DELETE FROM rights WHERE chunk = ?', name);
    const myDoors = this.myDoors();
    const allDoorIds = this.allDoorIdsFn();
    const rows = [];
    for (const g of asArray(body.grants)) {
      if (!g || !g.cardholderId) continue;
      let doors = g.doors ?? g.doorIds ?? (g.doorId ? [g.doorId] : []);
      if (doors === '*') doors = myDoors === null ? allDoorIds() : [...myDoors];
      for (const d of asArray(doors)) {
        const doorId = String(typeof d === 'object' && d ? (d.doorId || d.id) : d);
        if (myDoors !== null && !myDoors.has(doorId)) continue;
        rows.push([
          String(g.cardholderId), doorId, g.scheduleId ?? null, g.source || 'grant',
          g.refId ?? g.id ?? null, toMs(g.from ?? g.validFrom), toMs(g.to ?? g.validTo)
        ]);
      }
    }
    this.insertRights(rows, name);
  }

  applyPasses(name, body) {
    const db = this.db;
    db.run('DELETE FROM passes WHERE chunk = ?', name);
    const ins = db.cached('INSERT OR REPLACE INTO passes(id, dni, json, chunk) VALUES (?, ?, ?, ?)');
    for (const p of asArray(body.passes)) {
      const id = p && (p.id ?? p.qrId);
      if (!id) continue;
      ins.run(String(id), p.dni ? String(p.dni) : null, json(p), name);
    }
    db.run('DELETE FROM revocations');
    for (const id of asArray(body.revoked ?? body.revocations)) {
      if (id) db.run('INSERT OR IGNORE INTO revocations(id) VALUES (?)', String(id));
    }
  }

  applyOperators(body) {
    if (this.role !== 'hub') return;
    const db = this.db;
    db.run('DELETE FROM operators');
    const ins = db.cached(
      'INSERT OR REPLACE INTO operators(username, hash, pwd_version, perms_json, posts_json) VALUES (?, ?, ?, ?, ?)'
    );
    for (const o of asArray(body.operators)) {
      if (!o || !o.username) continue;
      ins.run(String(o.username), o.hash ?? null, Number(o.passwordVersion ?? o.pwdVersion ?? 0), json(o.perms ?? o.permissions ?? []), json(o.posts ?? []));
    }
  }
}

module.exports = {
  ChunkStore,
  ChunkHashError,
  canonicalJson,
  hashBody,
  toMs,
  chunkKind,
  DEFAULT_SCHEDULE
};
