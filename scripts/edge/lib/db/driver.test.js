'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SKIP, DRIVER, tmpDir, rmDir } = require('./_testkit');
const { open, openOrRecover, DbIntegrityError, checkIntegrity } = require('./driver');

describe('driver SQLite', { skip: SKIP }, () => {
  const dirs = [];
  after(() => dirs.forEach(rmDir));
  const newDir = () => {
    const d = tmpDir();
    dirs.push(d);
    return d;
  };

  it(`abre con WAL, synchronous=NORMAL y busy_timeout (driver ${DRIVER})`, () => {
    const db = open(path.join(newDir(), 'a.db'));
    try {
      assert.equal(db.driverName, DRIVER);
      assert.equal(String(db.pragma('journal_mode')).toLowerCase(), 'wal');
      assert.equal(Number(db.pragma('synchronous')), 1);
      assert.equal(Number(db.pragma('busy_timeout')), 5000);
    } finally {
      db.close();
    }
  });

  it('prepare/run/get/all con parámetros posicionales, nombrados, undefined y booleanos', () => {
    const db = open(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)');
      const r = db.run('INSERT INTO t(a, b) VALUES (?, ?)', 'x', true);
      assert.equal(r.changes, 1);
      assert.equal(r.lastInsertRowid, 1);
      db.prepare('INSERT INTO t(a, b) VALUES (@a, @b)').run({ a: undefined, b: false });
      assert.deepEqual(db.get('SELECT a, b FROM t WHERE id = ?', 1), { a: 'x', b: 1 });
      assert.deepEqual(db.all('SELECT a, b FROM t ORDER BY id'), [{ a: 'x', b: 1 }, { a: null, b: 0 }]);
      assert.equal(db.get('SELECT a FROM t WHERE id = ?', 99), undefined);
    } finally {
      db.close();
    }
  });

  it('transaction: commit, rollback ante excepción y savepoint anidado', () => {
    const db = open(':memory:');
    try {
      db.exec('CREATE TABLE t (v INTEGER)');
      db.tx(() => db.run('INSERT INTO t VALUES (1)'));
      assert.throws(() => db.tx(() => {
        db.run('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }), /boom/);
      db.tx(() => {
        db.run('INSERT INTO t VALUES (3)');
        assert.throws(() => db.tx(() => {
          db.run('INSERT INTO t VALUES (4)');
          throw new Error('interno');
        }));
        db.run('INSERT INTO t VALUES (5)');
      });
      assert.deepEqual(db.all('SELECT v FROM t ORDER BY v').map((r) => r.v), [1, 3, 5]);
      assert.equal(db.inTransaction, false);
    } finally {
      db.close();
    }
  });

  it('readonly no permite escribir', () => {
    const file = path.join(newDir(), 'ro.db');
    const w = open(file);
    w.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7)');
    w.close();
    const ro = open(file, { readonly: true });
    try {
      assert.equal(ro.get('SELECT v FROM t').v, 7);
      assert.throws(() => ro.run('INSERT INTO t VALUES (8)'));
    } finally {
      ro.close();
    }
  });

  it('archivo que no es SQLite → DbIntegrityError recuperable', () => {
    const file = path.join(newDir(), 'basura.db');
    fs.writeFileSync(file, Buffer.alloc(8192, 0x41));
    assert.throws(() => open(file), (err) => err instanceof DbIntegrityError && err.recoverable === true && err.code === 'DB_INTEGRITY');
  });

  it('página corrupta → integrity_check falla con DbIntegrityError y openOrRecover aparta el archivo', () => {
    const dir = newDir();
    const file = path.join(dir, 'corrupta.db');
    const db = open(file);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX t_v ON t(v);');
    const ins = db.prepare('INSERT INTO t(v) VALUES (?)');
    db.tx(() => {
      for (let i = 0; i < 3000; i += 1) ins.run(`valor-${i}-${'x'.repeat(40)}`);
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const pageSize = Number(db.pragma('page_size'));
    db.close();
    const buf = fs.readFileSync(file);
    // Pisar varias páginas intermedias (no la 1, que tiene el encabezado).
    for (let off = pageSize * 3; off < Math.min(buf.length, pageSize * 12); off += 1) buf[off] = (off * 7) & 0xff;
    fs.writeFileSync(file, buf);

    assert.throws(() => open(file), (err) => err instanceof DbIntegrityError && err.recoverable);

    const res = openOrRecover(file);
    try {
      assert.equal(res.recovered, true);
      assert.ok(res.error instanceof DbIntegrityError);
      assert.ok(fs.existsSync(res.movedTo), 'el archivo corrupto queda apartado para análisis');
      assert.equal(checkIntegrity(res.db), true);
      assert.equal(res.db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 't'").n, 0);
    } finally {
      res.db.close();
    }
  });
});
