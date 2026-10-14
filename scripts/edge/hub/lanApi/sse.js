'use strict';

/**
 * SSE de la app de guardia. El token va en ?token= porque EventSource no manda headers.
 * Keep-alive `: ping` cada 20 s. Los eventos salen del bus del hub (ingesta, config, nube, ack).
 * `visitor`: aviso al guardia (visita/externo en puerta con aviso, o ingreso a aprobar), ver visitors.js.
 */

const { maskIdNumber } = require('./entries');
const { visitorAlert } = require('./visitors');

const PING_MS = 20 * 1000;

function safeWrite(res, chunk) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write(chunk);
    return true;
  } catch (_) {
    return false;
  }
}

function sendEvent(res, event, data) {
  return safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function personName(hub, ev) {
  const payload = ev.payload || {};
  if (payload.name || payload.cardholderName) return String(payload.name || payload.cardholderName);
  if (!ev.cardholderId) return '';
  try {
    const ch = hub.edge.snapshot.cardholder(ev.cardholderId);
    return (ch && ch.name) || '';
  } catch (_) {
    return '';
  }
}

function doorName(hub, doorId, payload) {
  if (payload && payload.doorName) return String(payload.doorName);
  if (!doorId) return null;
  try {
    const door = hub.edge.snapshot.door(doorId);
    return (door && door.name) || doorId;
  } catch (_) {
    return doorId;
  }
}

function isAlarm(ev) {
  if (!ev) return false;
  if (ev.type === 'alarm' || ev.type === 'alarm_clear') return true;
  return false;
}

function alarmCleared(ev) {
  return ev.type === 'alarm_clear' || (ev.type === 'alarm' && ev.payload && ev.payload.state === 'cleared');
}

function publishIngested(hub, res, events) {
  for (const ev of events || []) {
    try {
      if (ev.type === 'door_state') {
        const payload = ev.payload || {};
        const sinceRaw = Number(payload.since);
        sendEvent(res, 'door', {
          doorId: ev.doorId || null,
          state: payload.state || ev.state || null,
          dps: payload.dps ?? null,
          bond: payload.bond ?? null,
          since: Number.isFinite(sinceRaw) ? sinceRaw : (ev.ts ?? null)
        });
      } else if (ev.type === 'access' || ev.type === 'passage') {
        const payload = ev.payload || {};
        const idNumber = maskIdNumber(payload.idNumberMasked || payload.idNumber || '');
        sendEvent(res, 'access', {
          id: ev.id,
          name: personName(hub, ev),
          idNumber,
          doorId: ev.doorId || null,
          doorName: doorName(hub, ev.doorId, payload),
          side: ev.side || null,
          decision: ev.decision || null,
          reason: ev.reason || null,
          warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
          accessAuthorized: ev.decision === 'grant',
          timestamp: ev.ts ? new Date(Number(ev.ts)).toISOString() : null
        });
      }
      if (ev.type === 'approval_pending' || ev.type === 'access') {
        // 1b: cartel con sonido en la pantalla del guardia (visita, externo o aprobación).
        const alert = visitorAlert(hub, ev);
        if (alert) sendEvent(res, 'visitor', alert);
      }
      if (isAlarm(ev)) {
        const type = ev.type === 'alarm' ? (ev.reason || 'alarm') : (ev.payload && ev.payload.alarmType) || ev.type;
        sendEvent(res, 'alarm', {
          id: `${type}:${ev.doorId || ev.deviceId || 'sitio'}`,
          type,
          doorId: ev.doorId || null,
          state: alarmCleared(ev) ? 'cleared' : 'raised',
          at: ev.ts ? new Date(Number(ev.ts)).toISOString() : null
        });
      }
    } catch (err) {
      hub.log.warn(`[hub] sse: ${err.message}`);
    }
  }
}

function attachSse(req, res, hub, extraHeaders) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extraHeaders
  });
  safeWrite(res, ': ping\n\n');
  const onIngested = (events) => publishIngested(hub, res, events);
  const onConfig = (data) => sendEvent(res, 'config', data);
  const onRuntime = (data) => sendEvent(res, 'runtime', data);
  const onAlarm = (data) => sendEvent(res, 'alarm', data);
  hub.bus.on('ingested', onIngested);
  hub.bus.on('config', onConfig);
  hub.bus.on('runtime', onRuntime);
  hub.bus.on('alarm', onAlarm);
  const ping = setInterval(() => {
    if (!safeWrite(res, ': ping\n\n')) cleanup();
  }, PING_MS);
  if (ping.unref) ping.unref();
  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    hub.bus.off('ingested', onIngested);
    hub.bus.off('config', onConfig);
    hub.bus.off('runtime', onRuntime);
    hub.bus.off('alarm', onAlarm);
  }
  req.on('close', cleanup);
  res.on('close', cleanup);
}

module.exports = { attachSse, PING_MS };
