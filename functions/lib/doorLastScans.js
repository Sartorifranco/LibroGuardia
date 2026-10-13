'use strict';

/**
 * Últimos escaneos de una puerta.
 * Una consulta a `entries` (paginada) y una ventana corta del journal del sitio.
 */

const { db } = require('../firestore');
const { DEFAULT_SITE_ID, sanitizeSiteId } = require('./devices');

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const JOURNAL_WINDOW = 8;

const clampLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
};

const toMillis = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'object') {
    const seconds = value._seconds ?? value.seconds;
    if (Number.isFinite(Number(seconds))) return Number(seconds) * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const present = (row) => {
  const side = row.side === 'out' ? 'out' : 'in';
  const movement = side === 'out' ? 'salida' : 'entrada';
  const result = row.result === 'denegado' ? 'denegado' : 'permitido';
  const name = String(row.name || '').trim();
  return {
    id: String(row.id),
    at: new Date(row.at).toISOString(),
    name,
    side,
    movement,
    result,
    summary: [name || 'Sin nombre', movement, result].join(' · ')
  };
};

const isScanEvent = (ev) => {
  if (!ev || typeof ev !== 'object' || !ev.doorId) return false;
  const type = String(ev.type || '');
  if (!type || type === 'alarm') return false;
  if (type !== 'access' && type !== 'scan' && !ev.decision && !ev.credType) return false;
  return Number.isFinite(Number(ev.ts)) && Number(ev.ts) > 0;
};

/**
 * Une entradas y eventos, del más nuevo al más viejo.
 * @param {Array<{id:string, at:number, name?:string, side?:string, result?:string}>} rows
 */
const mergeScans = (rows, { limit = DEFAULT_LIMIT, before = null } = {}) => {
  const byId = new Map();
  (rows || []).forEach((row) => {
    if (!row || !row.id || !Number.isFinite(row.at) || row.at <= 0) return;
    if (before != null && row.at >= before) return;
    const prev = byId.get(row.id);
    if (!prev || row.at > prev.at) byId.set(row.id, row);
  });
  const ordered = [...byId.values()].sort((a, b) => b.at - a.at);
  const page = ordered.slice(0, limit);
  return {
    scans: page.map(present),
    nextCursor: ordered.length > limit ? String(page[page.length - 1].at) : null
  };
};

const fromEntry = (id, data = {}) => {
  const at = toMillis(data.timestamp) || toMillis(data.createdAt);
  if (!at) return null;
  const side = data.movementType === 'egreso' || data.tipoMovimiento === 'egreso' || data.side === 'out'
    ? 'out'
    : 'in';
  const denied = data.accessAuthorized === false || data.type === 'denied' || Boolean(data.denialReason);
  return {
    id: data.edge?.eventId || id,
    at,
    name: data.name || data.nameSnapshot || '',
    side,
    result: denied ? 'denegado' : 'permitido'
  };
};

const fromJournalEvent = (ev, doorId) => {
  if (!isScanEvent(ev) || String(ev.doorId) !== String(doorId)) return null;
  const denied = ev.decision && ev.decision !== 'grant';
  return {
    id: String(ev.id),
    at: Number(ev.ts),
    name: ev.payload?.name || ev.payload?.cardholderName || '',
    side: ev.side === 'out' ? 'out' : 'in',
    result: denied ? 'denegado' : 'permitido'
  };
};

/**
 * @param {{ doorId: string, siteId?: string, limit?: number|string, cursor?: string|null }} opts
 */
const listDoorLastScans = async ({ doorId, siteId, limit, cursor } = {}) => {
  const cleanId = String(doorId || '').trim();
  if (!cleanId || cleanId.length > 80) {
    const err = new Error('Puerta no válida');
    err.status = 400;
    throw err;
  }
  const n = clampLimit(limit);
  const before = cursor != null && cursor !== '' && Number.isFinite(Number(cursor)) ? Number(cursor) : null;
  const site = sanitizeSiteId(siteId || DEFAULT_SITE_ID);

  let entryQuery = db.collection('entries').where('doorId', '==', cleanId).orderBy('timestamp', 'desc');
  if (before != null) entryQuery = entryQuery.where('timestamp', '<', before);
  const journalQuery = db.collection('sites').doc(site).collection('journal').orderBy('lastTs', 'desc').limit(JOURNAL_WINDOW);

  const [entriesSnap, journalSnap] = await Promise.all([
    entryQuery.limit(n).get(),
    journalQuery.get()
  ]);

  const rows = [];
  entriesSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (String(data.doorId || '') !== cleanId) return;
    const row = fromEntry(doc.id, data);
    if (row) rows.push(row);
  });
  journalSnap.docs.forEach((doc) => {
    const events = Array.isArray(doc.data()?.events) ? doc.data().events : [];
    events.forEach((ev) => {
      const row = fromJournalEvent(ev, cleanId);
      if (row) rows.push(row);
    });
  });

  const page = mergeScans(rows, { limit: n, before });
  if (!page.nextCursor && entriesSnap.docs.length === n) {
    const oldest = entriesSnap.docs[entriesSnap.docs.length - 1];
    const at = toMillis(oldest.data()?.timestamp);
    if (at) page.nextCursor = String(at);
  }
  return page;
};

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampLimit,
  mergeScans,
  listDoorLastScans,
  toMillis
};
