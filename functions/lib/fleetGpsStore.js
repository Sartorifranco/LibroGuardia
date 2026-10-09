'use strict';

/**
 * Estado GPS de toda la flota en pocos documentos (ideal: uno solo).
 * Una lectura del doc principal por vuelta. Si no entra en 900 KB,
 * se parte de a 200 vehículos.
 */

const TRACKS_DOC = 'fleetGpsTracks';
const LEGACY_COLLECTION = 'fleetGpsTracks';
const MAX_BYTES = 900 * 1024;
const SHARD_SIZE = 200;
const HEARTBEAT_MS = 30 * 60 * 1000;

const shardDocId = (index) => (index === 0 ? TRACKS_DOC : `${TRACKS_DOC}_${index}`);

const stripUndefined = (obj) => {
  const out = {};
  Object.entries(obj || {}).forEach(([key, value]) => {
    if (value !== undefined) out[key] = value;
  });
  return out;
};

const measureBytes = (tracks) => Buffer.byteLength(JSON.stringify(tracks), 'utf8');

/**
 * Hay que guardar el vehículo si cambió la zona, si pasó de quieto a en movimiento
 * (o al revés), si cambió el cruce pendiente / registrado, o si pasaron 30 minutos
 * (latido para no perder el rastro).
 */
const trackNeedsWrite = (prev, next, nowMs = Date.now()) => {
  if (!prev) return true;
  if ((prev.zone || null) !== (next.zone || null)) return true;
  if (Boolean(prev.moving) !== Boolean(next.moving)) return true;
  if ((prev.pendingDirection || null) !== (next.pendingDirection || null)) return true;
  if (next.movementLogged) return true;
  if ((prev.lastEntryId || null) !== (next.lastEntryId || null)) return true;
  const last = Date.parse(prev.lastWrittenAt || '') || 0;
  if (!last || (nowMs - last) >= HEARTBEAT_MS) return true;
  return false;
};

const loadTrackMap = async (db) => {
  const mainSnap = await db.collection('settings').doc(TRACKS_DOC).get();
  const main = mainSnap.exists ? (mainSnap.data() || {}) : null;
  if (main && (main.tracks || main.sharded)) {
    const map = new Map(Object.entries(main.tracks || {}));
    const shardCount = Math.max(1, Number(main.shardCount) || 1);
    if (main.sharded && shardCount > 1) {
      const refs = [];
      for (let i = 1; i < shardCount; i += 1) {
        refs.push(db.collection('settings').doc(shardDocId(i)));
      }
      const snaps = typeof db.getAll === 'function'
        ? await db.getAll(...refs)
        : await Promise.all(refs.map((ref) => ref.get()));
      snaps.forEach((snap) => {
        const tracks = snap && snap.exists ? (snap.data()?.tracks || {}) : {};
        Object.entries(tracks).forEach(([id, row]) => map.set(id, row));
      });
    }
    return { map, shardCount: main.sharded ? shardCount : 1 };
  }

  const legacy = await db.collection(LEGACY_COLLECTION).get();
  const map = new Map();
  (legacy.docs || []).forEach((doc) => {
    map.set(String(doc.id), doc.data() || {});
  });
  return { map, shardCount: 1 };
};

const planShards = (tracks) => {
  const entries = Object.entries(tracks);
  if (measureBytes(tracks) < MAX_BYTES) {
    return [{
      id: TRACKS_DOC,
      tracks,
      sharded: false,
      shardCount: 1,
      shardIndex: 0
    }];
  }
  const shards = [];
  for (let i = 0; i < entries.length; i += SHARD_SIZE) {
    const index = shards.length;
    shards.push({
      id: shardDocId(index),
      tracks: Object.fromEntries(entries.slice(i, i + SHARD_SIZE)),
      sharded: true,
      shardCount: 0,
      shardIndex: index
    });
  }
  if (!shards.length) {
    return [{
      id: TRACKS_DOC,
      tracks: {},
      sharded: false,
      shardCount: 1,
      shardIndex: 0
    }];
  }
  shards.forEach((shard) => {
    shard.shardCount = shards.length;
    shard.sharded = shards.length > 1;
  });
  return shards;
};

const saveTrackMap = async (db, map, previousShardCount = 1) => {
  const tracks = {};
  map.forEach((value, key) => {
    const row = stripUndefined(value);
    delete row.movementLogged;
    tracks[String(key)] = row;
  });
  const shards = planShards(tracks);
  for (const shard of shards) {
    await db.collection('settings').doc(shard.id).set({
      tracks: shard.tracks,
      sharded: shard.sharded,
      shardCount: shard.shardCount,
      shardIndex: shard.shardIndex,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  }
  const previous = Math.max(1, Number(previousShardCount) || 1);
  for (let i = shards.length; i < previous; i += 1) {
    await db.collection('settings').doc(shardDocId(i)).delete();
  }
  return { shards: shards.length };
};

module.exports = {
  TRACKS_DOC,
  LEGACY_COLLECTION,
  MAX_BYTES,
  SHARD_SIZE,
  HEARTBEAT_MS,
  trackNeedsWrite,
  loadTrackMap,
  saveTrackMap,
  planShards,
  measureBytes
};
