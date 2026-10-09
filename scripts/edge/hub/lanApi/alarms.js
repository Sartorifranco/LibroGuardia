'use strict';

/**
 * Alarmas abiertas de la tabla `alarms` en la forma de /api/guard/live-alerts,
 * con `kind:'alarm'`. Reconocer exige nota de al menos 3 caracteres y deja
 * un evento `alarm_ack` en el journal.
 */

const { hasAnyPerm } = require('./operators');

const ALERT_PERMS = ['entries.view', 'entries.create', 'access.kiosk', 'access.manual_open', 'attendance.alerts.read'];

const TITLES = {
  door_forced: 'Puerta forzada',
  held_open: 'Puerta retenida',
  lock_fault: 'Falla de cerradura',
  duress: 'Coacción',
  device_offline: 'Equipo sin conexión',
  tamper: 'Manipulación del equipo',
  apertura_forzada_estanco: 'Estanco forzado',
  hub_offline: 'Hub sin conexión',
  config_stale: 'Configuración desactualizada',
  emergency: 'Emergencia',
  interlock_violation: 'Violación del estanco',
  credential_key_missing: 'Falta la clave de credenciales'
};

const ERROR_TYPES = new Set(['door_forced', 'lock_fault', 'duress', 'tamper', 'emergency']);

function doorLabel(hub, doorId) {
  if (!doorId) return 'Sitio';
  try {
    const door = hub.edge.snapshot.door(doorId);
    return (door && door.name) || doorId;
  } catch (_) {
    return doorId;
  }
}

function toAlert(hub, row) {
  const title = TITLES[row.type] || 'Alarma';
  const where = doorLabel(hub, row.door_id);
  const restored = row.state === 'restored';
  return {
    id: row.id,
    kind: 'alarm',
    type: row.type,
    severity: restored ? 'info' : (ERROR_TYPES.has(row.type) ? 'error' : 'warn'),
    title: restored ? `${title} (normalizada)` : title,
    message: restored ? `${where}: se normalizó` : `${where}: ${title}`,
    at: new Date(Number(row.last_ts || row.first_ts)).toISOString(),
    meta: {
      doorId: row.door_id || null,
      count: row.count,
      state: row.state
    }
  };
}

function listLiveAlerts(hub, op) {
  if (!hasAnyPerm(op, ALERT_PERMS)) {
    return { status: 403, body: { message: 'No tenés permiso para ver las alarmas.' } };
  }
  const rows = hub.edge.db.all(
    "SELECT id, type, door_id, state, first_ts, last_ts, count FROM alarms WHERE state IN ('active','restored') AND ack_by IS NULL ORDER BY last_ts DESC LIMIT 100"
  );
  return {
    status: 200,
    body: {
      alerts: rows.map((row) => toAlert(hub, row)),
      queriedAt: new Date(hub.now()).toISOString()
    }
  };
}

function ackAlarm(hub, op, alarmId, note) {
  if (!hasAnyPerm(op, ALERT_PERMS)) {
    return { status: 403, body: { message: 'No tenés permiso para reconocer alarmas.' } };
  }
  const text = String(note || '').trim();
  if (text.length < 3) {
    return { status: 400, body: { message: 'La nota tiene que tener al menos 3 caracteres.' } };
  }
  const id = String(alarmId || '').trim();
  const row = hub.edge.db.get('SELECT id, type, door_id, state, ack_by FROM alarms WHERE id = ?', id);
  if (!row) return { status: 404, body: { message: 'No existe esa alarma.' } };
  const clipped = text.slice(0, 500);
  if (!row.ack_by) {
    hub.edge.db.run('UPDATE alarms SET ack_by = ?, ack_note = ? WHERE id = ?', op.username, clipped, id);
    try {
      hub.edge.journal.append({
        doorId: row.door_id || null,
        type: 'alarm_ack',
        decision: 'ack',
        reason: row.type,
        payload: { alarmId: id, note: clipped, operator: op.username }
      });
    } catch (err) {
      hub.log.warn(`[hub] journal alarm_ack: ${err.message}`);
    }
    if (hub.bus) {
      hub.bus.emit('alarm', {
        id,
        type: row.type,
        doorId: row.door_id || null,
        state: 'acked',
        note: clipped,
        operator: op.username,
        at: new Date(hub.now()).toISOString()
      });
    }
  }
  return { status: 200, body: { ok: true } };
}

module.exports = { listLiveAlerts, ackAlarm, ALERT_PERMS, TITLES };
