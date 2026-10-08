'use strict';

/** Utilidades compartidas por los tests de edge/lib/db (no es un test). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDriverName } = require('./driver');
const { hashBody } = require('./chunkStore');

const DRIVER = resolveDriverName();
const SKIP = DRIVER
  ? false
  : 'Sin driver SQLite: instalar better-sqlite3 en scripts/ (npm install) o usar Node 22.5+ con node:sqlite';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn(`[edge/lib/db] tests omitidos: ${SKIP}`);
}

function tmpDir(prefix = 'lg-edge-db-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Windows puede tener el archivo tomado un instante; no es fatal para el test.
  }
}

/** Head con los hashes correctos para los cuerpos dados. */
function makeHead(version, bodies, versions = {}) {
  const chunks = {};
  for (const [name, body] of Object.entries(bodies)) {
    chunks[name] = { v: versions[name] ?? version, hash: hashBody(body) };
  }
  return { version, chunks, sig: 'test', keyId: 'test' };
}

/** Bucket determinístico simple (la nube usa hash(personId) % 64). */
function bucketOf(id, buckets = 64) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `ch-${String(h % buckets).padStart(2, '0')}`;
}

/** Chunk doors sintético con forma de ETAPA2-DISENO §3. */
function doorsBody({ doorCount = 4, controllers = ['ctl-a', 'ctl-b'] } = {}) {
  const doors = [];
  for (let i = 1; i <= doorCount; i += 1) {
    doors.push({
      id: `p${i}`,
      name: `Puerta ${i}`,
      enabled: true,
      sides: ['in', 'out'],
      controllerId: controllers[Math.floor((i - 1) / 2) % controllers.length],
      unlockSec: 5,
      heldOpenSec: 30
    });
  }
  return {
    site: { id: 'principal', tz: 'America/Argentina/Buenos_Aires' },
    policy: { requireGuardApproval: false, apb: 'soft', maxConfigAgeDays: 7 },
    doors,
    schedules: [
      { id: '24x7', always: true },
      { id: 'sch_turno_m', days: [1, 2, 3, 4, 5], from: '06:00', to: '14:00', toleranceMin: 15 }
    ],
    holidays: [{ date: '2026-10-12', setId: 'AR' }, { date: '2026-12-25', setId: 'AR' }],
    interlockGroups: [{ id: 'est1', doorIds: ['p1', 'p2'], mode: 'timed' }],
    accessGroups: [
      { id: 'grp_total', doors: '*', scheduleId: '24x7' },
      { id: 'grp_planta', doors: [{ doorId: 'p1', scheduleId: 'sch_turno_m' }, { doorId: 'p3' }], scheduleId: '24x7' }
    ]
  };
}

/**
 * Personas sintéticas repartidas en buckets: { 'ch-NN': {bucket, cardholders:[...]}, ... }.
 * Cada persona: 2 credenciales (dni + card). Derechos variados según el índice.
 */
function cardholderChunks(count, { doorCount = 4, buckets = 64 } = {}) {
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const id = `per_${i}`;
    const name = bucketOf(id, buckets);
    if (!out[name]) out[name] = { bucket: Number(name.slice(3)), cardholders: [] };
    const ch = {
      id,
      status: 'active',
      name: `Persona ${i}`,
      credentials: [
        { type: 'dni', valueHash: `h_dni_${i}`, status: 'active' },
        { type: 'card', valueHash: `h_card_${i}`, status: 'active' }
      ]
    };
    const mod = i % 10;
    if (mod === 0) ch.accessAll = true;
    else if (mod < 4) ch.accessLevels = ['grp_planta'];
    else if (mod < 6) ch.doors = [{ doorId: `p${(i % doorCount) + 1}`, scheduleId: '24x7' }];
    else if (mod === 6) ch.accessLevels = ['grp_total'];
    else ch.allowedDoorIds = [`p${(i % doorCount) + 1}`, `p${((i + 1) % doorCount) + 1}`];
    out[name].cardholders.push(ch);
  }
  return out;
}

module.exports = {
  DRIVER, SKIP, tmpDir, rmDir, makeHead, bucketOf, doorsBody, cardholderChunks
};
