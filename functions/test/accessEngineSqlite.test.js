'use strict';

/**
 * Misma tabla dorada del motor, pero contra el SqliteSnapshot del edge (T3,
 * scripts/edge/lib/db). Garantiza que la implementación en memoria (nube) y la
 * SQLite (edge) deciden igual. Se omite si no hay driver SQLite (better-sqlite3
 * en scripts/node_modules o Node 22.5+ con node:sqlite).
 */

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChunks, buildKeyedChunks } = require('./accessEngineFixture');
const { runGolden, THU_10, dni } = require('./accessEngineGoldenCases');
const { decide, createMemorySnapshot, hashCredential, credentialKeyId } = require('../lib/accessEngine');

const EDGE_DB = path.resolve(__dirname, '../../scripts/edge/lib/db');

let edgeDb = null;
let skip = false;
try {
  edgeDb = require(EDGE_DB);
  if (!edgeDb.resolveDriverName()) skip = 'sin driver SQLite (instalar better-sqlite3 en scripts/)';
} catch (err) {
  skip = `scripts/edge/lib/db no disponible: ${err.message}`;
}

const opened = [];
const makeSnap = (overrides) => {
  const bodies = JSON.parse(JSON.stringify(buildChunks(overrides)));
  const head = { version: 1, chunks: {}, sig: 'test', keyId: 'test' };
  for (const [name, body] of Object.entries(bodies)) head.chunks[name] = { v: 1, hash: edgeDb.hashBody(body) };
  const edge = edgeDb.openEdgeDb(':memory:', { role: 'hub', deviceId: 'hub-test' });
  opened.push(edge);
  const r = edge.chunks.applyHead(head, bodies);
  if (!r.applied) throw new Error(`applyHead no aplicó: ${JSON.stringify(r)}`);
  return edge.snapshot.refresh();
};

// ── Sitio con clave HMAC de credenciales (chunk `secrets`, pases con dniHash) ──
const KEY = Buffer.alloc(32, 7).toString('base64');
const applyKeyed = (overrides, { dropSecrets = false } = {}) => {
  const bodies = JSON.parse(JSON.stringify(buildKeyedChunks(KEY, overrides)));
  if (dropSecrets) delete bodies.secrets;
  const head = { version: 1, chunks: {}, sig: 'test', keyId: 'test' };
  for (const [name, body] of Object.entries(bodies)) head.chunks[name] = { v: 1, hash: edgeDb.hashBody(body) };
  // Controlador (no hub): el chunk secrets también le llega y lo guarda.
  const myDoorIds = bodies.doors.doors.map((d) => d.id);
  const edge = edgeDb.openEdgeDb(':memory:', { role: 'controller', deviceId: 'ctl-test', myDoorIds });
  opened.push(edge);
  const r = edge.chunks.applyHead(head, bodies);
  if (!r.applied) throw new Error(`applyHead no aplicó: ${JSON.stringify(r)}`);
  return edge;
};
const makeKeyedSnap = (overrides) => applyKeyed(overrides).snapshot.refresh();

if (skip) {
  test('motor (SQLite edge): tabla dorada', { skip }, () => {});
} else {
  runGolden('motor (SQLite edge)', makeSnap);
  runGolden('motor (SQLite edge, con clave HMAC)', makeKeyedSnap);
  runGolden('motor (memoria, con clave HMAC)', (o) => createMemorySnapshot(buildKeyedChunks(KEY, o)));

  test('clave HMAC: el snapshot SQLite la expone, la guarda en meta y no en claro en otras tablas', () => {
    const edge = applyKeyed();
    const snap = edge.snapshot.refresh();
    assert.equal(snap.credentialKey(), KEY);
    assert.equal(snap.credentialKeyId(), credentialKeyId(KEY));
    const dump = JSON.stringify(edge.db.all('SELECT * FROM credentials')) + JSON.stringify(edge.db.all('SELECT * FROM passes'));
    assert.ok(!dump.includes(KEY));
    assert.ok(!dump.includes('40111222'), 'el DNI de la visita no viaja en claro');
    // passes.dni indexa el dniHash
    const p = snap.pass(hashCredential('dni', '40111222', KEY));
    assert.equal(p && p.id, 'QR-P1');
  });

  test('clave HMAC: sin el chunk secrets ningún DNI coincide (por eso es todo-o-nada)', () => {
    const snap = applyKeyed(undefined, { dropSecrets: true }).snapshot.refresh();
    assert.equal(snap.credentialKey(), null);
    const r = decide({ snap, credential: dni('20000001'), doorId: 'D1', at: THU_10, state: { doorStates: {}, presence: {} }, mode: 'scan' });
    assert.equal(r.reason, 'credencial_desconocida');
  });

  test('clave HMAC: quitar el chunk secrets en un head nuevo borra la clave', () => {
    const edge = applyKeyed();
    const bodies = JSON.parse(JSON.stringify(buildChunks()));
    const head = { version: 2, chunks: {} };
    for (const [name, body] of Object.entries(bodies)) head.chunks[name] = { v: 2, hash: edgeDb.hashBody(body) };
    assert.equal(edge.chunks.applyHead(head, bodies).applied, true);
    assert.equal(edge.snapshot.refresh().credentialKey(), null);
  });
  test.after(() => {
    for (const e of opened) {
      try { e.db.close(); } catch (_) { /* ya cerrada */ }
    }
  });
}
