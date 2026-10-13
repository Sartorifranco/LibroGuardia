'use strict';

/**
 * Apertura manual: el hub valida permiso, puesto y (si hace falta) el forzado
 * del estanco, y reenvía al controlador dueño con la firma LAN de controllers.call.
 * Se usa call y no openDoor() porque ese método no copia `permissions` al body;
 * el controlador las lee de `permissions` o de `requestedBy.permissions`.
 * Queda un `manual_open` en el journal del hub con el operador.
 */

const { hasPerm } = require('./operators');
const { doorVisible } = require('./doors');

const MIN_FORCE_REASON = 5;

function loadDoor(db, doorId) {
  const row = db.get('SELECT id, json FROM doors WHERE id = ?', doorId);
  if (!row) return null;
  try { return { ...JSON.parse(row.json), id: row.id }; } catch (_) { return { id: row.id }; }
}

function mapResult(result) {
  const code = result.code || (result.body && result.body.code) || null;
  const status = Number(result.status) || 0;
  if (result.ok === true && code !== 'AIRLOCK_OTHER_OPEN' && code !== 'COOLDOWN' && code !== 'RELAY_ERROR') {
    return { http: 200, code: null };
  }
  if (code === 'AIRLOCK_OTHER_OPEN' || status === 409) return { http: 409, code: 'AIRLOCK_OTHER_OPEN' };
  if (code === 'COOLDOWN' || status === 429) return { http: 429, code: 'COOLDOWN' };
  if (status === 403) return { http: 403, code: code || 'FORBIDDEN' };
  if (status === 400) return { http: 400, code: code || 'BAD_REQUEST' };
  if (status === 404 || code === 'DOOR_NOT_FOUND') return { http: 404, code: code || 'DOOR_NOT_FOUND' };
  return { http: 502, code: code || 'CONTROLLER_ERROR' };
}

function messageFor(http, result) {
  if (result.message && http !== 502) return String(result.message);
  if (http === 200) {
    return result.relayConfirmed === false
      ? 'Pedido enviado, pero la puerta no confirmó.'
      : 'Puerta abierta.';
  }
  if (http === 409) return result.message || 'La otra puerta del estanco está abierta.';
  if (http === 429) return result.message || 'La puerta se acaba de abrir. Esperá unos segundos.';
  if (http === 403) return result.message || 'No tenés permiso para abrir esta puerta.';
  if (http === 404) return result.message || 'Esa puerta no está en el controlador.';
  if (http === 400) return result.message || 'No se pudo abrir la puerta.';
  return 'No se pudo abrir la puerta. El controlador o el relé no responden.';
}

async function openGuardDoor(hub, op, body) {
  if (!hasPerm(op, 'access.manual_open')) {
    return { status: 403, body: { message: 'No tenés permiso para abrir puertas.' } };
  }
  const doorId = String((body && body.doorId) || '').trim();
  if (!doorId) return { status: 400, body: { message: 'Indicá qué puerta querés abrir.' } };
  const door = loadDoor(hub.edge.db, doorId);
  if (!door || door.enabled === false || door.active === false) {
    return { status: 404, body: { message: 'No existe esa puerta.' } };
  }
  if (!doorVisible(op, door)) {
    return { status: 403, body: { message: 'No tenés esta puerta asignada.' } };
  }
  const forceAirlock = body.forceAirlock === true;
  const forceReason = String(body.forceReason || '').trim().slice(0, 500);
  if (forceAirlock) {
    if (!hasPerm(op, 'puertas.estanco.forzar')) {
      return { status: 403, body: { message: 'No tenés permiso para forzar la apertura del estanco.' } };
    }
    if (forceReason.length < MIN_FORCE_REASON) {
      return { status: 400, body: { message: 'Indicá el motivo para forzar la apertura del estanco.' } };
    }
  }
  hub.edge.snapshot.refresh();
  const owner = hub.controllers.ownerOf(doorId, hub.edge.snapshot);
  if (!owner) {
    return { status: 502, body: { code: 'DOOR_NOT_ROUTED', message: 'No hay controlador para esta puerta.' } };
  }
  const reason = forceAirlock
    ? `estanco_forzado: ${forceReason}`
    : String(body.reason || 'apertura_manual_guardia').slice(0, 500);
  const requestedBy = { id: op.id, username: op.username, permissions: op.permissions };
  let result;
  try {
    const data = await hub.controllers.call(owner.deviceId, 'POST', `/edge/doors/${encodeURIComponent(doorId)}/open`, {
      requestedBy,
      permissions: op.permissions,
      reason,
      force: forceAirlock,
      forceAuthorized: forceAirlock,
      ...(forceAirlock ? { forceReason } : {}),
      mode: 'manual'
    });
    result = data && typeof data === 'object' ? data : { ok: true };
  } catch (err) {
    result = {
      ok: false,
      status: err.status || 502,
      code: (err.body && err.body.code) || err.code || 'CONTROLLER_ERROR',
      message: (err.body && err.body.message) || null,
      forcible: err.body && err.body.forcible,
      relayConfirmed: err.body && err.body.relayConfirmed,
      eventId: err.body && err.body.eventId
    };
  }
  const mapped = mapResult(result);
  let audit = null;
  try {
    audit = hub.edge.journal.append({
      doorId,
      type: 'manual_open',
      decision: mapped.http === 200 ? 'grant' : 'deny',
      reason: mapped.code || result.reason || null,
      payload: {
        operator: op.username,
        requestedBy: op.username,
        permissions: op.permissions,
        reason,
        force: forceAirlock,
        forceReason: forceAirlock ? forceReason : null,
        relayConfirmed: result.relayConfirmed === true,
        code: mapped.code,
        controllerId: owner.deviceId,
        controllerEventId: result.eventId || null
      }
    });
  } catch (err) {
    hub.log.warn(`[hub] journal manual_open: ${err.message}`);
  }
  const eventId = (audit && audit.id) || result.eventId || null;
  const message = messageFor(mapped.http, result);
  if (mapped.http === 200) {
    return {
      status: 200,
      body: {
        ok: true,
        message,
        relayConfirmed: result.relayConfirmed === true,
        eventId,
        ...(result.eventId ? { controllerEventId: result.eventId } : {})
      }
    };
  }
  const payload = { message, ...(mapped.code ? { code: mapped.code } : {}), ...(eventId ? { eventId } : {}) };
  if (mapped.http === 409) payload.forcible = result.forcible !== false;
  if (mapped.http === 429 && result.retryAfterMs) payload.retryAfterSeconds = Math.ceil(Number(result.retryAfterMs) / 1000);
  return { status: mapped.http, body: payload };
}

module.exports = { openGuardDoor, MIN_FORCE_REASON };
