'use strict';

/**
 * Misma tabla dorada del motor, pero contra el SqliteSnapshot del edge (T3,
 * scripts/edge/lib/db). Garantiza que la implementación en memoria (nube) y la
 * SQLite (edge) deciden igual. Se omite si no hay driver SQLite (better-sqlite3
 * en scripts/node_modules o Node 22.5+ con node:sqlite).
 */

const path = require('node:path');
const test = require('node:test');
const { buildChunks } = require('./accessEngineFixture');
const { runGolden } = require('./accessEngineGoldenCases');

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

if (skip) {
  test('motor (SQLite edge): tabla dorada', { skip }, () => {});
} else {
  runGolden('motor (SQLite edge)', makeSnap);
  test.after(() => {
    for (const e of opened) {
      try { e.db.close(); } catch (_) { /* ya cerrada */ }
    }
  });
}
