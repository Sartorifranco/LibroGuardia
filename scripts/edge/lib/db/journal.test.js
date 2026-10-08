'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { SKIP, tmpDir, rmDir } = require('./_testkit');
const { open, checkIntegrity } = require('./driver');
const { migrate } = require('./migrations');
const { Journal } = require('./journal');

const DAY = 24 * 60 * 60 * 1000;

function openJournal(file, opts) {
  const db = open(file);
  migrate(db, { role: opts.role || 'controller' });
  return { db, j: new Journal(db, opts) };
}

describe('journal', { skip: SKIP }, () => {
  const dirs = [];
  after(() => dirs.forEach(rmDir));
  const newFile = (name = 'j.db') => {
    const d = tmpDir();
    dirs.push(d);
    return path.join(d, name);
  };

  it('seq monotónico persistido: sobrevive cerrar/reabrir y no reusa números tras purgar', () => {
    const file = newFile();
    let { db, j } = openJournal(file, { deviceId: 'ctl-a' });
    const e1 = j.append({ doorId: 'p1', side: 'in', type: 'access', decision: 'grant', reason: 'ok', payload: { ms: 120 }, ts: 1000 });
    assert.equal(e1.id, 'ctl-a:1');
    assert.equal(e1.seq, 1);
    j.append({ ts: 2000 });
    j.append({ ts: 3000 });
    db.close();

    ({ db, j } = openJournal(file, { deviceId: 'ctl-a' }));
    assert.equal(j.lastSeq(), 3);
    const e4 = j.append({ ts: 4000 });
    assert.equal(e4.id, 'ctl-a:4');
    assert.deepEqual(j.get('ctl-a:1').payload, { ms: 120 });
    // Confirmar y purgar todo: el próximo seq sigue en 5.
    j.ack(4);
    assert.equal(j.purge({ retentionDays: 0, now: 10_000 }), 4);
    db.close();
    ({ db, j } = openJournal(file, { deviceId: 'ctl-a' }));
    try {
      assert.equal(j.append({ ts: 11_000 }).seq, 5);
    } finally {
      db.close();
    }
  });

  it('pendingBatch y ack en el controlador', () => {
    const { db, j } = openJournal(':memory:', { deviceId: 'ctl-a' });
    try {
      for (let i = 0; i < 5; i += 1) j.append({ ts: i });
      assert.deepEqual(j.pendingBatch(2).map((e) => e.seq), [1, 2]);
      assert.equal(j.ack(3), 3);
      assert.deepEqual(j.pendingBatch(10).map((e) => e.seq), [4, 5]);
      assert.equal(j.ack(3), 0, 'ack repetido no hace nada');
      assert.deepEqual(j.stats(), { total: 5, pending: 2, lastSeq: 5, lastHubSeq: 0, ackedUpto: 3 });
    } finally {
      db.close();
    }
  });

  it('hub: ingest idempotente (INSERT OR IGNORE), hub_seq solo para nuevos, mismos seq de distintos equipos', () => {
    const file = newFile('hub.db');
    let { db, j } = openJournal(file, { deviceId: 'hub-1', role: 'hub' });
    const batchA = [1, 2, 3].map((seq) => ({ id: `ctl-a:${seq}`, deviceId: 'ctl-a', seq, ts: seq * 10, doorId: 'p1', decision: 'grant' }));
    const batchB = [1, 2].map((seq) => ({ deviceId: 'ctl-b', seq, ts: seq * 10 + 5, doorId: 'p3', decision: 'deny', reason: 'credencial_desconocida' }));
    assert.deepEqual(j.ingest(batchA), { inserted: 3, duplicates: 0, ackSeqByDevice: { 'ctl-a': 3 } });
    assert.deepEqual(j.ingest(batchB), { inserted: 2, duplicates: 0, ackSeqByDevice: { 'ctl-b': 2 } });
    // Reintento del controlador (no recibió el ack) + un evento nuevo.
    const retry = [...batchA.slice(1), { deviceId: 'ctl-a', seq: 4, ts: 40 }];
    assert.deepEqual(j.ingest(retry), { inserted: 1, duplicates: 2, ackSeqByDevice: { 'ctl-a': 4 } });
    const own = j.append({ type: 'alarm', ts: 50 });
    assert.equal(own.id, 'hub-1:1');
    assert.equal(own.hubSeq, 7);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM events').n, 7);
    const pending = j.pendingBatch(200);
    assert.deepEqual(pending.map((e) => e.hubSeq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(pending.map((e) => e.id), ['ctl-a:1', 'ctl-a:2', 'ctl-a:3', 'ctl-b:1', 'ctl-b:2', 'ctl-a:4', 'hub-1:1']);
    assert.throws(() => j.ingest([{ id: 'ctl-a:9', deviceId: 'ctl-a', seq: 8 }]), (e) => e.code === 'EVENT_INVALID');
    // La nube responde ackHubSeq=5.
    assert.equal(j.ack(5), 5);
    db.close();
    ({ db, j } = openJournal(file, { deviceId: 'hub-1', role: 'hub' }));
    try {
      assert.deepEqual(j.pendingBatch(10).map((e) => e.hubSeq), [6, 7]);
      assert.equal(j.ingest([{ deviceId: 'ctl-c', seq: 1, ts: 60 }]).inserted, 1);
      assert.equal(j.get('ctl-c:1').hubSeq, 8, 'hub_seq persiste entre reinicios');
      assert.throws(() => new Journal(db, { deviceId: 'ctl-a' }).ingest([]), /solo en el hub/);
    } finally {
      db.close();
    }
  });

  it('purge borra solo eventos confirmados más viejos que la retención (90 días por defecto)', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const { db, j } = openJournal(':memory:', { deviceId: 'ctl-a', now: () => now });
    try {
      j.append({ ts: now - 120 * DAY }); // 1 viejo, se confirma
      j.append({ ts: now - 100 * DAY }); // 2 viejo, se confirma
      j.append({ ts: now - 10 * DAY }); // 3 reciente, se confirma
      j.append({ ts: now - 200 * DAY }); // 4 viejo SIN confirmar
      j.ack(3);
      assert.equal(j.purge(), 2);
      assert.deepEqual(db.all('SELECT seq FROM events ORDER BY seq').map((r) => r.seq), [3, 4]);
      assert.equal(j.purge({ retentionDays: 1 }), 1);
      assert.deepEqual(db.all('SELECT seq FROM events ORDER BY seq').map((r) => r.seq), [4]);
    } finally {
      db.close();
    }
  });

  it('crash real a mitad de una transacción (proceso matado) deja la base consistente', () => {
    const file = newFile('crash.db');
    const dbDir = __dirname.replace(/\\/g, '/');
    const child = `
      const { open } = require(${JSON.stringify(`${dbDir}/driver`)});
      const { migrate, writeMeta } = require(${JSON.stringify(`${dbDir}/migrations`)});
      const { Journal } = require(${JSON.stringify(`${dbDir}/journal`)});
      const db = open(process.argv[1]);
      migrate(db, { role: 'controller' });
      const j = new Journal(db, { deviceId: 'ctl-a' });
      for (let i = 0; i < 50; i += 1) j.append({ ts: i, doorId: 'p1' });
      // Transacción a medio hacer: avanza el seq y escribe filas, pero nunca hace COMMIT.
      db.exec('BEGIN IMMEDIATE');
      for (let i = 51; i <= 80; i += 1) {
        writeMeta(db, 'journal_seq', i);
        db.run("INSERT INTO events(id, seq, ts, device_id) VALUES (?, ?, ?, 'ctl-a')", 'ctl-a:' + i, i, i);
      }
      db.run("INSERT INTO doors(id, json) VALUES ('px', '{}')");
      process.stdout.write('ANTES_DEL_CORTE\\n');
      process.kill(process.pid, 'SIGKILL');
    `;
    const res = spawnSync(process.execPath, ['-e', child, file], { encoding: 'utf8', timeout: 30_000 });
    assert.match(res.stdout, /ANTES_DEL_CORTE/, res.stderr);
    assert.notEqual(res.status, 0, 'el hijo no terminó normalmente');

    const { db, j } = openJournal(file, { deviceId: 'ctl-a' });
    try {
      assert.equal(checkIntegrity(db), true);
      assert.equal(j.lastSeq(), 50);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM events').n, 50);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM doors').n, 0);
      assert.equal(j.append({ ts: 99 }).id, 'ctl-a:51');
    } finally {
      db.close();
    }
  });
});
