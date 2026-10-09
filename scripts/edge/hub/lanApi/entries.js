'use strict';

/**
 * Pasos del journal → forma `entries` de la nube (libro de guardia).
 * Rango en hora de Argentina, igual que functions/lib/entriesQuery.js.
 * Se listan access y passage (concedidos y denegados). manual_open no es un paso.
 */

const { hasAnyPerm } = require('./operators');

const TZ = 'America/Argentina/Buenos_Aires';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const ENTRY_PERMS = ['entries.view', 'reports.export'];

function ymdInAR(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(ms));
}

function startMs(ymd) {
  return Date.parse(`${ymd}T00:00:00.000-03:00`);
}

function endMs(ymd) {
  return Date.parse(`${ymd}T23:59:59.999-03:00`);
}

function maskIdNumber(raw) {
  if (raw == null || raw === '') return '';
  const text = String(raw);
  if (text.includes('*')) return text.slice(0, 20);
  const compact = text.replace(/\s+/g, '');
  if (!compact) return '';
  if (compact.length <= 3) return '*'.repeat(compact.length);
  return `${'*'.repeat(compact.length - 3)}${compact.slice(-3)}`;
}

function eventTime(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  return `${get('hour')}:${get('minute')}`;
}

function doorNameOf(hub, doorId, payload) {
  if (payload && payload.doorName) return String(payload.doorName).slice(0, 120);
  if (!doorId) return null;
  try {
    const door = hub.edge.snapshot.door(doorId);
    return (door && door.name) || doorId;
  } catch (_) {
    return doorId;
  }
}

function personName(hub, ev, payload) {
  if (payload && (payload.name || payload.cardholderName)) return String(payload.name || payload.cardholderName).slice(0, 160);
  if (!ev.cardholder_id) return '';
  try {
    const ch = hub.edge.snapshot.cardholder(ev.cardholder_id);
    return (ch && ch.name) || '';
  } catch (_) {
    return '';
  }
}

function toEntry(hub, row) {
  let payload = {};
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch (_) { payload = {}; }
  const tipo = row.side === 'out' ? 'egreso' : 'ingreso';
  const idNumber = payload.idNumberMasked
    ? maskIdNumber(payload.idNumberMasked)
    : (payload.idNumber ? maskIdNumber(payload.idNumber) : (row.cred_hash ? '***' : ''));
  const name = personName(hub, row, payload);
  const authorized = row.decision === 'grant';
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  return {
    id: row.id,
    _id: row.id,
    type: 'personal',
    tipoMovimiento: tipo,
    movementType: tipo,
    name,
    nameSnapshot: name,
    idNumber,
    dniSnapshot: idNumber || null,
    personId: row.cardholder_id || null,
    doorId: row.door_id || null,
    doorName: doorNameOf(hub, row.door_id, payload),
    timestamp: new Date(Number(row.ts)).toISOString(),
    eventTime: eventTime(Number(row.ts)),
    accessAuthorized: authorized,
    authorized,
    accessReason: row.reason || null,
    denialReason: authorized ? null : (row.reason || null),
    entrySource: 'edge',
    warnings,
    side: row.side || null
  };
}

function listEntries(hub, op, query) {
  if (!hasAnyPerm(op, ENTRY_PERMS)) {
    return { status: 403, body: { message: 'No tenés permiso para ver el libro.' } };
  }
  const now = hub.now();
  const today = ymdInAR(now);
  const startDate = query.get('startDate') || today;
  const endDate = query.get('endDate') || startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { status: 400, body: { message: 'Fechas inválidas. Usá formato YYYY-MM-DD.' } };
  }
  const from = startMs(startDate);
  const to = endMs(endDate);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { status: 400, body: { message: 'Fechas inválidas. Usá formato YYYY-MM-DD.' } };
  }
  const type = query.get('type') || 'todos';
  const q = String(query.get('q') || query.get('search') || '').trim().toLowerCase();
  let limit = Number(query.get('limit'));
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  if (type && type !== 'todos' && type !== 'personal') {
    return {
      status: 200,
      body: {
        entries: [],
        page: { limit, hasMore: false, nextCursor: null },
        meta: { startDate, endDate, type, q }
      }
    };
  }

  const params = [from, to];
  let cursorSql = '';
  const cursor = query.get('cursor');
  if (cursor) {
    const cur = hub.edge.db.get('SELECT ts, id FROM events WHERE id = ?', cursor);
    if (cur) {
      cursorSql = 'AND (ts < ? OR (ts = ? AND id < ?))';
      params.push(cur.ts, cur.ts, cur.id);
    }
  }
  let searchSql = '';
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '')}%`;
    searchSql = 'AND (lower(ifnull(payload_json, \'\')) LIKE ? OR lower(ifnull(reason, \'\')) LIKE ? OR lower(ifnull(door_id, \'\')) LIKE ? OR lower(ifnull(cardholder_id, \'\')) LIKE ?)';
    params.push(like, like, like, like);
  }
  params.push(limit + 1);
  const rows = hub.edge.db.all(
    `SELECT id, ts, door_id, side, type, cred_hash, cardholder_id, decision, reason, payload_json
     FROM events
     WHERE type IN ('access','passage') AND ts >= ? AND ts <= ? ${cursorSql} ${searchSql}
     ORDER BY ts DESC, id DESC
     LIMIT ?`,
    ...params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const entries = page.map((row) => toEntry(hub, row));
  return {
    status: 200,
    body: {
      entries,
      page: { limit, hasMore, nextCursor: hasMore && page.length ? page[page.length - 1].id : null },
      meta: { startDate, endDate, type, q }
    }
  };
}

module.exports = { listEntries, maskIdNumber, ymdInAR, ENTRY_PERMS };
