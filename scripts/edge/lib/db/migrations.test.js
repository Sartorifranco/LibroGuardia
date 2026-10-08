'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SKIP, tmpDir, rmDir } = require('./_testkit');
const { open } = require('./driver');
const { migrate, readMeta, writeMeta, LATEST_VERSION } = require('./migrations');

const HUB_ONLY = ['presence', 'alarms', 'operators', 'commands'];
const COMMON = ['meta', 'chunks', 'cardholders', 'credentials', 'rights', 'schedules', 'holidays', 'doors',
  'interlocks', 'access_groups', 'passes', 'revocations', 'events', 'door_state'];

function tables(db) {
  return db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
}

function indexes(db) {
  return db.all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL");
}

describe('migraciones', { skip: SKIP }, () => {
  const dirs = [];
  after(() => dirs.forEach(rmDir));

  it('controller: tablas comunes, sin tablas de hub, índices pedidos', () => {
    const db = open(':memory:');
    try {
      const r = migrate(db, { role: 'controller' });
      assert.deepEqual(r, { from: 0, to: LATEST_VERSION, role: 'controller', applied: [1] });
      const t = tables(db);
      for (const name of COMMON) assert.ok(t.includes(name), `falta ${name}`);
      for (const name of HUB_ONLY) assert.ok(!t.includes(name), `no debería existir ${name}`);
      const idx = indexes(db).map((i) => i.sql.replace(/\s+/g, ' '));
      const has = (re) => idx.some((s) => re.test(s));
      assert.ok(has(/ON credentials\(type, value_hash\)/));
      assert.ok(has(/ON rights\(cardholder_id, door_id\)/));
      assert.ok(has(/ON events\(acked, seq\)/));
      assert.ok(has(/ON events\(door_id, ts\)/));
      assert.equal(readMeta(db, 'schema_version'), String(LATEST_VERSION));
    } finally {
      db.close();
    }
  });

  it('es idempotente (correr dos veces y reabrir no cambia nada ni pierde datos)', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const file = path.join(dir, 'm.db');
    let db = open(file);
    migrate(db, { role: 'controller' });
    db.run("INSERT INTO doors(id, json) VALUES ('p1', '{}')");
    const before = db.all("SELECT type, name, sql FROM sqlite_master ORDER BY name");
    assert.deepEqual(migrate(db, { role: 'controller' }).applied, []);
    db.close();
    db = open(file);
    try {
      assert.deepEqual(migrate(db, { role: 'controller' }).applied, []);
      assert.deepEqual(db.all("SELECT type, name, sql FROM sqlite_master ORDER BY name"), before);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM doors').n, 1);
    } finally {
      db.close();
    }
  });

  it('hub: agrega tablas de hub; pasar de controller a hub las crea sin tocar lo demás', () => {
    const hub = open(':memory:');
    try {
      migrate(hub, { role: 'hub' });
      for (const name of HUB_ONLY) assert.ok(tables(hub).includes(name));
      assert.ok(indexes(hub).some((i) => /events\(acked, hub_seq\)/.test(i.sql)));
    } finally {
      hub.close();
    }
    const db = open(':memory:');
    try {
      migrate(db, { role: 'controller' });
      db.run("INSERT INTO doors(id, json) VALUES ('p1', '{}')");
      const r = migrate(db, { role: 'hub' });
      assert.equal(r.role, 'hub');
      for (const name of HUB_ONLY) assert.ok(tables(db).includes(name));
      assert.equal(db.get('SELECT COUNT(*) AS n FROM doors').n, 1);
      // Un hub no vuelve a controller.
      assert.equal(migrate(db, { role: 'controller' }).role, 'hub');
      assert.equal(readMeta(db, 'schema_role'), 'hub');
    } finally {
      db.close();
    }
  });

  it('rechaza un esquema más nuevo que el programa', () => {
    const db = open(':memory:');
    try {
      migrate(db);
      writeMeta(db, 'schema_version', LATEST_VERSION + 1);
      assert.throws(() => migrate(db), (err) => err.code === 'SCHEMA_TOO_NEW');
    } finally {
      db.close();
    }
  });
});
