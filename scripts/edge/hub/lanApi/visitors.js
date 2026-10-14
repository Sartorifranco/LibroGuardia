'use strict';

/**
 * Aviso al guardia cuando pasa una visita o un externo (PENDIENTES 1b) y aprobación de ingresos
 * de puertas con `requireGuardApproval` (1.3b).
 *
 * - `visitorAlert(hub, ev)`: arma el cartel para el SSE (`event: visitor`) o null si no corresponde.
 *   Siempre avisa una aprobación pendiente; un paso concedido solo si la puerta tiene
 *   `notifyGuardOnVisitor` y no es un empleado (acceso general, por grupo o directo).
 * - GET /api/guard/approvals: pendientes que siguen vivas (salen del journal del hub).
 * - POST /api/guard/approvals/:id {approve}: se reenvía al controlador dueño, que abre como
 *   apertura manual (respeta el estanco) o registra el rechazo.
 */

const { hasPerm } = require('./operators');
const { doorVisible } = require('./doors');
const { maskIdNumber } = require('./entries');
const { mapResult, messageFor } = require('./openDoor');

/** La aprobación vence en el controlador a los 60 s (approvalTtlMs); margen por relojes. */
const APPROVAL_WINDOW_MS = 2 * 60 * 1000;
/** Fuentes de empleados: no avisan, para no cansar al guardia. */
const EMPLOYEE_SOURCES = new Set(['accessAll', 'group', 'direct']);

function loadDoor(db, doorId) {
  if (!doorId) return null;
  const row = db.get('SELECT id, json FROM doors WHERE id = ?', doorId);
  if (!row) return null;
  try { return { ...JSON.parse(row.json), id: row.id }; } catch (_) { return { id: row.id }; }
}

function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch (_) { return {}; }
}

function snapshotGet(hub, kind, id) {
  if (!id) return null;
  try { return hub.edge.snapshot[kind](id) || null; } catch (_) { return null; }
}

/** Visita (pase), externo (autorización temporal/citación/visita) o null si es empleado. */
function kindOf(payload) {
  if (payload.passId) return 'visita';
  const source = payload.matched && payload.matched.source;
  if (!source || EMPLOYEE_SOURCES.has(source)) return null;
  return 'externo';
}

function buildAlert(hub, ev, door, kind) {
  const payload = parsePayload(ev.payload);
  const pass = snapshotGet(hub, 'pass', payload.passId);
  const holder = snapshotGet(hub, 'cardholder', ev.cardholderId);
  const name = String(payload.name || payload.cardholderName || (pass && pass.name) || (holder && holder.name) || '');
  const ts = Number(ev.ts) || Date.now();
  return {
    id: ev.id,
    kind,
    approvalId: payload.approvalId || null,
    name,
    idNumber: maskIdNumber(payload.idNumberMasked || payload.idNumber || ''),
    hostName: (pass && pass.hostName) || null,
    hostCompany: (pass && pass.hostCompany) || null,
    destination: (pass && pass.destination) || null,
    doorId: ev.doorId || null,
    doorName: (door && door.name) || payload.doorName || ev.doorId || null,
    side: ev.side || null,
    decision: ev.decision || null,
    reason: ev.reason || null,
    at: new Date(ts).toISOString()
  };
}

function visitorAlert(hub, ev) {
  if (!ev) return null;
  const door = loadDoor(hub.edge.db, ev.doorId);
  if (ev.type === 'approval_pending') {
    return buildAlert(hub, ev, door, 'aprobacion');
  }
  if (ev.type !== 'access' || ev.decision !== 'grant' || ev.reason === 'lectura_repetida') return null;
  if (!door || door.notifyGuardOnVisitor !== true) return null;
  const kind = kindOf(parsePayload(ev.payload));
  return kind ? buildAlert(hub, ev, door, kind) : null;
}

function rowToEvent(row) {
  return {
    id: row.id,
    ts: row.ts,
    deviceId: row.device_id,
    doorId: row.door_id,
    side: row.side,
    type: row.type,
    cardholderId: row.cardholder_id,
    decision: row.decision,
    reason: row.reason,
    payload: parsePayload(row.payload_json)
  };
}

/** Pendientes vivas: approval_pending sin approval_resolved, dentro de la ventana. */
function pendingApprovals(hub) {
  const since = hub.now() - APPROVAL_WINDOW_MS;
  const rows = hub.edge.db.all(
    `SELECT id, ts, device_id, door_id, side, type, cardholder_id, decision, reason, payload_json
     FROM events
     WHERE type IN ('approval_pending','approval_resolved') AND ts >= ?
     ORDER BY ts ASC, id ASC`,
    since
  );
  const pending = new Map();
  for (const row of rows) {
    const ev = rowToEvent(row);
    const approvalId = ev.payload.approvalId;
    if (!approvalId) continue;
    if (ev.type === 'approval_pending') pending.set(approvalId, ev);
    else pending.delete(approvalId);
  }
  return [...pending.values()];
}

function listApprovals(hub, op) {
  if (!hasPerm(op, 'access.manual_open')) {
    return { status: 403, body: { message: 'No tenés permiso para aprobar ingresos.' } };
  }
  const approvals = pendingApprovals(hub)
    .filter((ev) => {
      const door = loadDoor(hub.edge.db, ev.doorId);
      return door && doorVisible(op, door);
    })
    .map((ev) => buildAlert(hub, ev, loadDoor(hub.edge.db, ev.doorId), 'aprobacion'));
  return { status: 200, body: { approvals } };
}

async function resolveGuardApproval(hub, op, approvalId, body = {}) {
  if (!hasPerm(op, 'access.manual_open')) {
    return { status: 403, body: { message: 'No tenés permiso para aprobar ingresos.' } };
  }
  const ev = pendingApprovals(hub).find((p) => p.payload.approvalId === approvalId);
  if (!ev) {
    return { status: 404, body: { code: 'APPROVAL_NOT_FOUND', message: 'La solicitud ya no está pendiente (venció o la resolvió otro guardia).' } };
  }
  const door = loadDoor(hub.edge.db, ev.doorId);
  if (!door || !doorVisible(op, door)) {
    return { status: 403, body: { message: 'No tenés esta puerta asignada.' } };
  }
  const approve = body.approve === true;
  const requestedBy = { id: op.id, username: op.username, permissions: op.permissions };
  let result;
  try {
    const data = await hub.controllers.call(ev.deviceId, 'POST', `/edge/approvals/${encodeURIComponent(approvalId)}`, {
      approve,
      requestedBy,
      permissions: op.permissions,
      reason: approve ? 'Aprobado por guardia' : 'Rechazado por guardia'
    });
    result = data && typeof data === 'object' ? data : { ok: true };
  } catch (err) {
    result = {
      ok: false,
      status: err.status || 502,
      code: (err.body && err.body.code) || err.code || 'CONTROLLER_ERROR',
      message: (err.body && err.body.message) || null,
      forcible: err.body && err.body.forcible
    };
  }
  if (result.code === 'APPROVAL_NOT_FOUND') {
    return { status: 404, body: { code: 'APPROVAL_NOT_FOUND', message: result.message || 'La solicitud venció.' } };
  }
  const mapped = mapResult(result);
  if (mapped.http === 200) {
    return {
      status: 200,
      body: {
        ok: true,
        approve,
        message: approve ? messageFor(200, result) : 'Ingreso rechazado.',
        relayConfirmed: approve ? result.relayConfirmed === true : null,
        eventId: result.eventId || null
      }
    };
  }
  return {
    status: mapped.http,
    body: {
      ok: false,
      code: mapped.code,
      message: messageFor(mapped.http, result),
      ...(result.forcible ? { forcible: true } : {})
    }
  };
}

module.exports = { visitorAlert, listApprovals, resolveGuardApproval, APPROVAL_WINDOW_MS };
