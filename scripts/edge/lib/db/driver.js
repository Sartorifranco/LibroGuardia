'use strict';

/**
 * Adaptador SQLite del edge (hub y controlador).
 *
 * Usa `node:sqlite` (DatabaseSync) cuando el runtime lo trae (Node 22.5+ / Node 24 LTS
 * portable de producción) y cae a `better-sqlite3` en Node 20 (PC del banco).
 * Se puede forzar con la opción `driver` o la variable `MSS_SQLITE_DRIVER`
 * (`node:sqlite` | `better-sqlite3`).
 *
 * API uniforme: open(path, opts) → Db { exec, prepare, run, get, all, transaction, pragma, close }.
 * Los parámetros se pasan posicionales (`?`) o como objeto con nombres sin prefijo (`@x`, `:x`, `$x`).
 * `undefined` → NULL y booleanos → 0/1 (ningún driver los acepta tal cual).
 */

const fs = require('fs');
const path = require('path');

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

class DbIntegrityError extends Error {
  /**
   * Error recuperable: la base está corrupta o no es SQLite. Quien la abre debe
   * apartar el archivo (ver `openOrRecover`) y pedir el bundle completo a la nube/hub.
   */
  constructor(message, { file = null, details = [], cause = null } = {}) {
    super(message);
    this.name = 'DbIntegrityError';
    this.code = 'DB_INTEGRITY';
    this.recoverable = true;
    this.file = file;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isCorruptionError(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_CORRUPT' || err.code === 'SQLITE_NOTADB') return true;
  const errcode = Number(err.errcode);
  if (Number.isFinite(errcode) && ((errcode & 0xff) === SQLITE_CORRUPT || (errcode & 0xff) === SQLITE_NOTADB)) {
    return true;
  }
  return /malformed|not a database|file is encrypted/i.test(String(err.message || ''));
}

let nodeSqliteCache;
function loadNodeSqlite() {
  if (nodeSqliteCache !== undefined) return nodeSqliteCache;
  try {
    // eslint-disable-next-line global-require
    nodeSqliteCache = require('node:sqlite');
  } catch (_) {
    nodeSqliteCache = null;
  }
  return nodeSqliteCache;
}

let betterSqliteCache;
function loadBetterSqlite() {
  if (betterSqliteCache !== undefined) return betterSqliteCache;
  try {
    // eslint-disable-next-line global-require
    betterSqliteCache = require('better-sqlite3');
  } catch (_) {
    betterSqliteCache = null;
  }
  return betterSqliteCache;
}

/** Driver que se usaría con las opciones dadas, o null si no hay ninguno. */
function resolveDriverName(preferred = process.env.MSS_SQLITE_DRIVER || 'auto') {
  if (preferred === 'node:sqlite') return loadNodeSqlite() ? 'node:sqlite' : null;
  if (preferred === 'better-sqlite3') return loadBetterSqlite() ? 'better-sqlite3' : null;
  if (loadNodeSqlite()) return 'node:sqlite';
  if (loadBetterSqlite()) return 'better-sqlite3';
  return null;
}

function normalizeValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalizeParams(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object'
    && !Array.isArray(params[0]) && !Buffer.isBuffer(params[0]) && !ArrayBuffer.isView(params[0])) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) out[k] = normalizeValue(v);
    return [out];
  }
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map(normalizeValue);
}

function plainRow(row) {
  if (!row || Object.getPrototypeOf(row) === Object.prototype) return row;
  return { ...row };
}

class Statement {
  constructor(raw, file) {
    this.raw = raw;
    this.file = file;
  }

  wrap(fn) {
    try {
      return fn();
    } catch (err) {
      if (isCorruptionError(err)) {
        throw new DbIntegrityError(`SQLite corrupta: ${err.message}`, { file: this.file, cause: err });
      }
      throw err;
    }
  }

  run(...params) {
    const p = normalizeParams(params);
    return this.wrap(() => {
      const r = this.raw.run(...p);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    });
  }

  get(...params) {
    const p = normalizeParams(params);
    return this.wrap(() => plainRow(this.raw.get(...p)));
  }

  all(...params) {
    const p = normalizeParams(params);
    return this.wrap(() => this.raw.all(...p).map(plainRow));
  }
}

class Db {
  constructor(raw, { driverName, file, readonly }) {
    this.raw = raw;
    this.driverName = driverName;
    this.file = file;
    this.readonly = readonly;
    this.txDepth = 0;
    this.stmtCache = new Map();
    this.closed = false;
  }

  exec(sql) {
    try {
      this.raw.exec(sql);
    } catch (err) {
      if (isCorruptionError(err)) {
        throw new DbIntegrityError(`SQLite corrupta: ${err.message}`, { file: this.file, cause: err });
      }
      throw err;
    }
    return this;
  }

  prepare(sql) {
    try {
      return new Statement(this.raw.prepare(sql), this.file);
    } catch (err) {
      if (isCorruptionError(err)) {
        throw new DbIntegrityError(`SQLite corrupta: ${err.message}`, { file: this.file, cause: err });
      }
      throw err;
    }
  }

  /** Statement preparado y cacheado por texto SQL (para consultas calientes). */
  cached(sql) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) { return this.cached(sql).run(...params); }

  get(sql, ...params) { return this.cached(sql).get(...params); }

  all(sql, ...params) { return this.cached(sql).all(...params); }

  /** PRAGMA simple → primer valor de la primera fila (o todas las filas con `{ all:true }`). */
  pragma(text, { all = false } = {}) {
    const rows = this.prepare(`PRAGMA ${text}`).all();
    if (all) return rows;
    if (!rows.length) return undefined;
    return Object.values(rows[0])[0];
  }

  get inTransaction() {
    return this.txDepth > 0;
  }

  /**
   * Devuelve una función que corre `fn` dentro de una transacción (BEGIN IMMEDIATE),
   * con SAVEPOINT si se anida. Rollback ante cualquier excepción. Solo sincrónico.
   */
  transaction(fn) {
    const db = this;
    return function runInTransaction(...args) {
      const depth = db.txDepth;
      const sp = `sp_${depth}`;
      if (depth === 0) db.exec(db.readonly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      else db.exec(`SAVEPOINT ${sp}`);
      db.txDepth += 1;
      let result;
      try {
        result = fn.apply(this, args);
        if (result && typeof result.then === 'function') {
          throw new Error('transaction(): la función debe ser sincrónica');
        }
      } catch (err) {
        db.txDepth -= 1;
        try {
          if (depth === 0) db.exec('ROLLBACK');
          else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        } catch (_) {
          // la transacción ya pudo haber sido revertida por SQLite
        }
        throw err;
      }
      db.txDepth -= 1;
      if (depth === 0) db.exec('COMMIT');
      else db.exec(`RELEASE ${sp}`);
      return result;
    };
  }

  /** Atajo: corre `fn(db)` en una transacción ya mismo. */
  tx(fn) {
    return this.transaction(() => fn(this))();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stmtCache.clear();
    this.raw.close();
  }
}

/**
 * Corre PRAGMA integrity_check (o quick_check) y lanza DbIntegrityError si no da "ok".
 */
function checkIntegrity(db, { quick = false } = {}) {
  let rows;
  try {
    rows = db.pragma(quick ? 'quick_check' : 'integrity_check', { all: true });
  } catch (err) {
    if (err instanceof DbIntegrityError) throw err;
    if (isCorruptionError(err)) {
      throw new DbIntegrityError(`SQLite corrupta: ${err.message}`, { file: db.file, cause: err });
    }
    throw err;
  }
  const details = rows.map((r) => String(Object.values(r)[0]));
  if (details.length === 1 && details[0] === 'ok') return true;
  throw new DbIntegrityError('PRAGMA integrity_check falló', { file: db.file, details });
}

function openRaw(driverName, file, readonly) {
  if (driverName === 'node:sqlite') {
    const { DatabaseSync } = loadNodeSqlite();
    return new DatabaseSync(file, { readOnly: readonly });
  }
  const Better = loadBetterSqlite();
  return new Better(file, readonly ? { readonly: true, fileMustExist: true } : {});
}

/**
 * Abre la base.
 * @param {string} file ruta o ':memory:'
 * @param {object} [opts]
 * @param {boolean} [opts.readonly=false]
 * @param {'auto'|'node:sqlite'|'better-sqlite3'} [opts.driver]
 * @param {boolean|'quick'} [opts.integrityCheck=true] PRAGMA integrity_check al abrir
 * @param {'NORMAL'|'FULL'} [opts.synchronous='NORMAL']
 * @param {number} [opts.busyTimeoutMs=5000]
 * @throws {DbIntegrityError} si la base está corrupta (recuperable con openOrRecover)
 */
function open(file, opts = {}) {
  const {
    readonly = false,
    driver = process.env.MSS_SQLITE_DRIVER || 'auto',
    integrityCheck = true,
    synchronous = 'NORMAL',
    busyTimeoutMs = 5000
  } = opts;
  const driverName = resolveDriverName(driver);
  if (!driverName) {
    const err = new Error(`No hay driver SQLite disponible (pedido: ${driver}). Instalar better-sqlite3 o usar Node 22.5+.`);
    err.code = 'SQLITE_DRIVER_MISSING';
    throw err;
  }
  const memory = file === ':memory:' || file === '';
  if (!memory && !readonly) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  let raw;
  try {
    raw = openRaw(driverName, file, readonly);
  } catch (err) {
    if (isCorruptionError(err)) throw new DbIntegrityError(`SQLite corrupta: ${err.message}`, { file, cause: err });
    throw err;
  }
  const db = new Db(raw, { driverName, file, readonly });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) | 0)}`);
    if (!readonly && !memory) db.pragma('journal_mode = WAL');
    db.exec(`PRAGMA synchronous = ${synchronous === 'FULL' ? 'FULL' : 'NORMAL'}`);
    if (integrityCheck) checkIntegrity(db, { quick: integrityCheck === 'quick' });
  } catch (err) {
    try { db.close(); } catch (_) { /* ignore */ }
    if (err instanceof DbIntegrityError) throw err;
    if (isCorruptionError(err)) throw new DbIntegrityError(`SQLite corrupta: ${err.message}`, { file, cause: err });
    throw err;
  }
  return db;
}

/**
 * Abre la base; si está corrupta la aparta (`<file>.corrupt-<ts>` + -wal/-shm) y crea una vacía.
 * Devuelve { db, recovered, movedTo, error }. Con recovered=true quien llama debe pedir
 * el bundle completo (config) y avisar que los eventos no subidos quedaron en el archivo apartado.
 */
function openOrRecover(file, opts = {}) {
  try {
    return { db: open(file, opts), recovered: false, movedTo: null, error: null };
  } catch (err) {
    if (!(err instanceof DbIntegrityError) || file === ':memory:') throw err;
    const stamp = new Date().toISOString().replace(/[:.]/g, '');
    const movedTo = `${file}.corrupt-${stamp}`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, movedTo + suffix);
    }
    return { db: open(file, opts), recovered: true, movedTo, error: err };
  }
}

module.exports = {
  open,
  openOrRecover,
  checkIntegrity,
  resolveDriverName,
  isCorruptionError,
  DbIntegrityError,
  Db
};
