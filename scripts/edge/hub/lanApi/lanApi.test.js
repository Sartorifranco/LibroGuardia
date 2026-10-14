'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('../../../../functions/node_modules/bcryptjs');
const k = require('../_hubkit');

const PERMS = ['access.manual_open', 'entries.view', 'puertas.estanco.forzar'];

function addOperator(db, { username, hash, version = 1, perms = PERMS, posts = [] }) {
  db.run(
    'INSERT INTO operators(username, hash, pwd_version, perms_json, posts_json) VALUES (?, ?, ?, ?, ?)',
    username, hash, version, JSON.stringify(perms), JSON.stringify(posts)
  );
}

function addDoor(db, door) {
  db.run('INSERT INTO doors(id, json) VALUES (?, ?)', door.id, JSON.stringify(door));
}

async function api(base, path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  }
  return { status: res.status, data, headers: res.headers };
}

describe('API LAN del hub para la app de guardia', { skip: k.SKIP }, () => {
  const dirs = [];
  let hubKeys;
  let ctlKeys;
  let ctl;
  let built;
  let hash;
  let token;
  let tokenPuesto;

  before(async () => {
    hash = bcrypt.hashSync('clave123', 4);
    hubKeys = k.generateKeyPair();
    ctlKeys = k.generateKeyPair();
    ctl = await k.startFakeController({ deviceId: 'ctl-a', hubDeviceId: 'hub-1', hubPublicKey: hubKeys.publicKeyPem });
    const dir = k.tmpDir('lg-hub-lanapi-');
    dirs.push(dir);
    built = await k.buildHub({
      dir,
      cloud: null,
      hubKeys,
      controllers: [{ deviceId: 'ctl-a', publicKey: ctlKeys.publicKeyPem, url: ctl.url, doorIds: ['p1', 'p2', 'p9'] }]
    });
    const db = built.hub.edge.db;
    addOperator(db, { username: 'guardia', hash, posts: [] });
    addOperator(db, { username: 'puesto', hash, posts: ['p1'] });
    addOperator(db, { username: 'bruto', hash, posts: [] });
    addOperator(db, { username: 'rota', hash, version: 1, posts: [] });
    addDoor(db, { id: 'p1', name: 'Portón', enabled: true, controllerId: 'ctl-a', sides: ['in', 'out'], unlockSec: 3 });
    addDoor(db, { id: 'p2', name: 'Oficinas', enabled: true, controllerId: 'ctl-a', sides: ['in', 'out'] });
    addDoor(db, { id: 'p9', name: 'Cerrada', enabled: false, controllerId: 'ctl-a' });
    db.run(
      'INSERT INTO interlocks(id, json) VALUES (?, ?)',
      'est1',
      JSON.stringify({ id: 'est1', doorIds: ['p1', 'p2'], mode: 'sensor' })
    );
    const now = Date.now();
    db.run('INSERT INTO door_state(door_id, state, since, dps, bond) VALUES (?,?,?,?,?)', 'p1', 'SEGURA', now - 5000, 'closed', 'locked');
    db.run('INSERT INTO door_state(door_id, state, since, dps, bond) VALUES (?,?,?,?,?)', 'p2', 'FORZADA', now - 1000, 'open', 'unlocked');
    built.hub.controllers.markSeen('ctl-a');
  });

  after(async () => {
    if (built) await built.hub.stop();
    if (ctl) await ctl.close();
    dirs.forEach(k.rmDir);
  });

  it('runtime anuncia modo LAN y una ruta desconocida responde 501', async () => {
    const runtime = await api(built.url, '/api/runtime');
    assert.equal(runtime.status, 200);
    assert.equal(runtime.data.mode, 'lan');
    assert.equal(runtime.data.siteId, 'principal');
    assert.equal(runtime.data.hubId, 'hub-1');
    assert.equal(runtime.data.cloudOnline, false);
    assert.equal(typeof runtime.data.configVersion, 'number');
    assert.deepEqual(runtime.data.capabilities, ['auth', 'doors', 'open', 'entries', 'alarms', 'live', 'scan', 'approvals']);
    const other = await api(built.url, '/api/guard/citados/today');
    assert.equal(other.status, 501);
    assert.equal(other.data.code, 'EDGE_UNSUPPORTED');
    assert.equal(other.data.message, 'Disponible solo con internet');
  });

  it('login correcto, clave mal y bloqueo a los 5 fallos', async () => {
    const bad = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'guardia', password: 'no' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.message, 'Credenciales inválidas');
    const ok = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'guardia', password: 'clave123' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.token.split('.').length, 3);
    assert.equal(ok.data.user.username, 'guardia');
    assert.equal(ok.data.user.role, 'guardia');
    assert.equal(ok.data.user.mustChangePassword, false);
    assert.ok(ok.data.user.permissions.includes('access.manual_open'));
    token = ok.data.token;
    const puesto = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'puesto', password: 'clave123' } });
    assert.equal(puesto.status, 200);
    tokenPuesto = puesto.data.token;

    for (let i = 1; i <= 4; i += 1) {
      const fail = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'bruto', password: 'mal' } });
      assert.equal(fail.status, 400, `intento ${i}`);
    }
    const fifth = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'bruto', password: 'mal' } });
    assert.equal(fifth.status, 429);
    assert.equal(fifth.data.code, 'LOGIN_LOCKED');
    const still = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'bruto', password: 'clave123' } });
    assert.equal(still.status, 429);
    const other = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'guardia', password: 'clave123' } });
    assert.equal(other.status, 200, 'el bloqueo es por usuario, no global');
    token = other.data.token;
  });

  it('me responde el operador y un token viejo muere si cambia passwordVersion', async () => {
    const me = await api(built.url, '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.id, 'guardia');
    assert.equal(me.data.user.username, 'guardia');
    assert.deepEqual(me.data.user.permissions, PERMS);
    const rota = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'rota', password: 'clave123' } });
    assert.equal(rota.status, 200);
    built.hub.edge.db.run('UPDATE operators SET pwd_version = 2 WHERE username = ?', 'rota');
    const stale = await api(built.url, '/api/auth/me', { token: rota.data.token });
    assert.equal(stale.status, 401);
    assert.match(stale.data.message, /contraseña/);
    const again = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'rota', password: 'clave123' } });
    assert.equal(again.status, 200);
    const fresh = await api(built.url, '/api/auth/me', { token: again.data.token });
    assert.equal(fresh.status, 200);
    const pwd = await api(built.url, '/api/auth/change-password', {
      method: 'POST', token, body: { currentPassword: 'clave123', newPassword: 'otra-clave' }
    });
    assert.equal(pwd.status, 501);
    assert.match(pwd.data.message, /Cambiá tu contraseña cuando haya internet/);
  });

  it('lista solo las puertas del puesto, con estado vivo y estanco', async () => {
    const all = await api(built.url, '/api/guard/doors', { token });
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.doors.map((d) => d.id), ['p1', 'p2']);
    const p1 = all.data.doors.find((d) => d.id === 'p1');
    assert.equal(p1.name, 'Portón');
    assert.equal(p1.live.state, 'SEGURA');
    assert.equal(p1.live.dps, 'closed');
    assert.equal(p1.health.status, 'online');
    assert.equal(p1.lastPulse, null);
    assert.deepEqual(p1.airlock, { groupId: 'est1', phase: 'other_open' });
    const p2 = all.data.doors.find((d) => d.id === 'p2');
    assert.equal(p2.live.state, 'FORZADA');
    assert.equal(p2.health.status, 'problem');
    assert.equal(p2.airlock.phase, 'this_open');
    const only = await api(built.url, '/api/guard/doors', { token: tokenPuesto });
    assert.deepEqual(only.data.doors.map((d) => d.id), ['p1']);
  });

  it('open-door se reenvía al controlador, incluido el 409 del estanco', async () => {
    const denied = await api(built.url, '/api/guard/open-door', {
      method: 'POST', token: tokenPuesto, body: { doorId: 'p2', reason: 'no' }
    });
    assert.equal(denied.status, 403);
    assert.equal(ctl.opens.length, 0);

    const opened = await api(built.url, '/api/guard/open-door', {
      method: 'POST', token, body: { doorId: 'p1', reason: 'proveedor' }
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.data.ok, true);
    assert.equal(opened.data.relayConfirmed, true);
    assert.ok(opened.data.eventId);
    const sent = ctl.opens.at(-1);
    assert.equal(sent.doorId, 'p1');
    assert.deepEqual(sent.permissions, PERMS);
    assert.equal(sent.requestedBy.username, 'guardia');
    assert.equal(sent.force, false);
    const audit = built.hub.edge.db.get('SELECT type, payload_json FROM events WHERE id = ?', opened.data.eventId);
    assert.equal(audit.type, 'manual_open');
    assert.match(audit.payload_json, /guardia/);

    ctl.openResponse = { ok: false, code: 'AIRLOCK_OTHER_OPEN', message: 'La otra puerta del estanco está abierta.', forcible: true };
    const air = await api(built.url, '/api/guard/open-door', {
      method: 'POST', token, body: { doorId: 'p1' }
    });
    assert.equal(air.status, 409);
    assert.equal(air.data.code, 'AIRLOCK_OTHER_OPEN');
    assert.equal(air.data.forcible, true);
    assert.match(air.data.message, /estanco/);

    const before = ctl.opens.length;
    const short = await api(built.url, '/api/guard/open-door', {
      method: 'POST', token, body: { doorId: 'p1', forceAirlock: true, forceReason: 'no' }
    });
    assert.equal(short.status, 400);
    assert.equal(ctl.opens.length, before);

    ctl.openResponse = { ok: true, relayConfirmed: true, eventId: 'ctl-a:9' };
    const forced = await api(built.url, '/api/guard/open-door', {
      method: 'POST', token, body: { doorId: 'p1', forceAirlock: true, forceReason: 'camión atascado' }
    });
    assert.equal(forced.status, 200);
    assert.equal(forced.data.relayConfirmed, true);
    assert.equal(forced.data.controllerEventId, 'ctl-a:9');
    const forceSent = ctl.opens.at(-1);
    assert.equal(forceSent.force, true);
    assert.equal(forceSent.forceAuthorized, true);
    assert.equal(forceSent.forceReason, 'camión atascado');
    assert.deepEqual(forceSent.permissions, PERMS);
  });

  it('entries de hoy salen del journal, con el documento enmascarado', async () => {
    const today = Date.now();
    built.hub.edge.journal.append({
      type: 'access',
      decision: 'grant',
      reason: 'puerta_directa',
      doorId: 'p1',
      side: 'in',
      cardholderId: 'ana',
      ts: today,
      payload: { name: 'Ana Pérez', idNumber: '30123456', warnings: ['apb_advertencia'], doorName: 'Portón' }
    });
    built.hub.edge.journal.append({
      type: 'access',
      decision: 'deny',
      reason: 'fuera_de_horario',
      doorId: 'p2',
      side: 'out',
      ts: today - 5 * 24 * 60 * 60 * 1000,
      payload: { name: 'Viejo', idNumber: '20111000', doorName: 'Oficinas' }
    });
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(today));
    const res = await api(built.url, `/api/entries?startDate=${ymd}&endDate=${ymd}&limit=200`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.data.entries.length, 1);
    const row = res.data.entries[0];
    assert.equal(row.type, 'personal');
    assert.equal(row.tipoMovimiento, 'ingreso');
    assert.equal(row.movementType, 'ingreso');
    assert.equal(row.name, 'Ana Pérez');
    assert.equal(row.idNumber, '*****456');
    assert.equal(JSON.stringify(res.data).includes('30123456'), false);
    assert.equal(row.doorId, 'p1');
    assert.equal(row.doorName, 'Portón');
    assert.equal(row.accessAuthorized, true);
    assert.equal(row.accessReason, 'puerta_directa');
    assert.equal(row.entrySource, 'edge');
    assert.deepEqual(row.warnings, ['apb_advertencia']);
    assert.equal(res.data.page.limit, 200);
  });

  it('lastPulse ignora denegados y pasos sin pulso, y refleja relayConfirmed', async () => {
    const now = Date.now();
    const journal = built.hub.edge.journal;
    const pulseOf = async (id) => {
      const doors = await api(built.url, '/api/guard/doors', { token });
      return doors.data.doors.find((d) => d.id === id).lastPulse;
    };
    journal.append({
      type: 'access', decision: 'deny', reason: 'credencial_desconocida', doorId: 'p2', ts: now,
      payload: { relayOk: false, relayConfirmed: false }
    });
    assert.equal(await pulseOf('p2'), null);

    journal.append({
      type: 'access', decision: 'grant', reason: 'nivel_acceso', doorId: 'p2', ts: now + 1000,
      payload: { relayOk: true, relayConfirmed: true, pulseAttempted: true }
    });
    let pulse = await pulseOf('p2');
    assert.equal(pulse.relayConfirmed, true);
    assert.equal(pulse.relayStatus, 'confirmado');
    assert.equal(pulse.at, new Date(now + 1000).toISOString());

    journal.append({
      type: 'access', decision: 'deny', reason: 'puerta_no_autorizada', doorId: 'p2', ts: now + 2000,
      payload: { relayOk: false, relayConfirmed: false }
    });
    journal.append({
      type: 'access', decision: 'grant', reason: 'paso_registrado_puerta_abierta', doorId: 'p2', ts: now + 3000,
      payload: { relayOk: true, relayConfirmed: true, extended: true }
    });
    pulse = await pulseOf('p2');
    assert.equal(pulse.at, new Date(now + 1000).toISOString());
    assert.equal(pulse.relayConfirmed, true);

    journal.append({
      type: 'manual_open', decision: 'grant', reason: 'apertura_manual', doorId: 'p2', ts: now + 4000,
      payload: { relayOk: true, relayConfirmed: false, pulseAttempted: true }
    });
    pulse = await pulseOf('p2');
    assert.equal(pulse.relayConfirmed, false);
    assert.equal(pulse.relayStatus, 'sin_confirmacion');
    assert.equal(pulse.at, new Date(now + 4000).toISOString());
  });

  it('live-alerts lista la alarma abierta y el ack exige nota', async () => {
    const now = Date.now();
    built.hub.edge.db.run(
      'INSERT INTO alarms(id, type, door_id, state, first_ts, last_ts, count) VALUES (?,?,?,?,?,?,1)',
      'door_forced:p1', 'door_forced', 'p1', 'active', now, now
    );
    const list = await api(built.url, '/api/guard/live-alerts', { token });
    assert.equal(list.status, 200);
    const alarm = list.data.alerts.find((a) => a.id === 'door_forced:p1');
    assert.ok(alarm);
    assert.equal(alarm.kind, 'alarm');
    assert.equal(alarm.type, 'door_forced');
    assert.equal(alarm.severity, 'error');
    assert.match(alarm.title, /forzada/i);
    const short = await api(built.url, '/api/guard/alarms/door_forced%3Ap1/ack', {
      method: 'POST', token, body: { note: 'ok' }
    });
    assert.equal(short.status, 400);
    const ack = await api(built.url, '/api/guard/alarms/door_forced%3Ap1/ack', {
      method: 'POST', token, body: { note: 'visto en ronda' }
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.data.ok, true);
    const again = await api(built.url, '/api/guard/live-alerts', { token });
    assert.equal(again.data.alerts.some((a) => a.id === 'door_forced:p1'), false);
    const audit = built.hub.edge.db.get("SELECT payload_json FROM events WHERE type = 'alarm_ack' ORDER BY ts DESC LIMIT 1");
    assert.match(audit.payload_json, /visto en ronda/);
    assert.match(audit.payload_json, /guardia/);
  });

  it('GET /api/guard/alarms lista y cerrar saca la alarma de las abiertas', async () => {
    const now = Date.now();
    built.hub.edge.db.run(
      'INSERT INTO alarms(id, type, door_id, state, first_ts, last_ts, count) VALUES (?,?,?,?,?,?,1)',
      'held:p9', 'held_open', 'p1', 'active', now, now
    );
    const list = await api(built.url, '/api/guard/alarms?status=open&limit=50', { token });
    assert.equal(list.status, 200);
    const alarm = list.data.alerts.find((a) => a.id === 'held:p9');
    assert.equal(alarm.kind, 'alarm');
    assert.equal(alarm.type, 'held_open');
    assert.ok(list.data.queriedAt);
    const closed = await api(built.url, '/api/guard/alarms/held%3Ap9/ack', {
      method: 'POST', token, body: { note: 'ya está bien', close: true }
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.ok, true);
    const again = await api(built.url, '/api/guard/alarms?status=open', { token });
    assert.equal(again.data.alerts.some((a) => a.id === 'held:p9'), false);
  });

  it('el SSE recibe un paso concedido', async () => {
    const ac = new AbortController();
    const res = await fetch(`${built.url}/api/live?token=${encodeURIComponent(token)}`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pull = async () => {
      const { value, done } = await reader.read();
      if (!done && value) buf += dec.decode(value, { stream: true });
    };
    await pull();
    assert.match(buf, /: ping/);
    built.hub.ingestFromController('ctl-a', {
      events: [{
        seq: 1,
        ts: Date.now(),
        doorId: 'p1',
        side: 'in',
        type: 'access',
        decision: 'grant',
        reason: 'puerta_directa',
        payload: { name: 'Ana Pérez', warnings: ['apb_advertencia'], doorName: 'Portón' }
      }]
    });
    const deadline = Date.now() + 2000;
    while (!buf.includes('event: access') && Date.now() < deadline) await pull();
    assert.match(buf, /event: access/);
    assert.match(buf, /Ana Pérez/);
    assert.match(buf, /apb_advertencia/);
    ac.abort();
  });
  it('1b: el SSE avisa al guardia una visita en puerta con aviso y una aprobación; un empleado no', async () => {
    const db = built.hub.edge.db;
    db.run('UPDATE doors SET json = ? WHERE id = ?', JSON.stringify({ id: 'p1', name: 'Portón', enabled: true, controllerId: 'ctl-a', sides: ['in', 'out'], notifyGuardOnVisitor: true }), 'p1');
    const ac = new AbortController();
    const res = await fetch(`${built.url}/api/live?token=${encodeURIComponent(token)}`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pull = async () => {
      const { value, done } = await reader.read();
      if (!done && value) buf += dec.decode(value, { stream: true });
    };
    await pull();
    const t = Date.now();
    built.hub.ingestFromController('ctl-a', {
      events: [
        { seq: 201, ts: t, doorId: 'p1', side: 'in', type: 'access', decision: 'grant', reason: 'puerta_directa', payload: { name: 'Empleado Uno', matched: { source: 'direct' } } },
        { seq: 202, ts: t + 1, doorId: 'p1', side: 'in', type: 'access', decision: 'grant', reason: 'visita', payload: { name: 'Juan Visita', passId: 'QR-9', matched: { source: 'pass', id: 'QR-9' } } },
        { seq: 203, ts: t + 2, doorId: 'p2', side: 'in', type: 'approval_pending', decision: 'needs_approval', reason: 'requiere_aprobacion_guardia', payload: { name: 'Cliente Dos', approvalId: 'apr-sse' } }
      ]
    });
    const deadline = Date.now() + 2000;
    while ((buf.match(/event: visitor/g) || []).length < 2 && Date.now() < deadline) await pull();
    ac.abort();
    const visitors = buf.split('\n\n').filter((b) => b.startsWith('event: visitor')).map((b) => JSON.parse(b.split('data: ')[1]));
    assert.equal(visitors.length, 2, buf);
    assert.equal(visitors[0].kind, 'visita');
    assert.equal(visitors[0].name, 'Juan Visita');
    assert.equal(visitors[0].doorName, 'Portón');
    assert.equal(visitors[1].kind, 'aprobacion');
    assert.equal(visitors[1].approvalId, 'apr-sse');
    assert.ok(!visitors.some((v) => v.name === 'Empleado Uno'));
  });

  it('1.3b: el guardia lista y aprueba un ingreso pendiente; resuelta ya no aparece', async () => {
    const t = Date.now();
    built.hub.ingestFromController('ctl-a', {
      events: [{ seq: 301, ts: t, doorId: 'p2', side: 'in', type: 'approval_pending', decision: 'needs_approval', reason: 'requiere_aprobacion_guardia', payload: { name: 'Cliente Tres', approvalId: 'apr-1' } }]
    });
    const list = await api(built.url, '/api/guard/approvals', { token });
    assert.equal(list.status, 200);
    const item = list.data.approvals.find((a) => a.approvalId === 'apr-1');
    assert.ok(item, JSON.stringify(list.data));
    assert.equal(item.name, 'Cliente Tres');
    assert.equal(item.doorName, 'Oficinas');

    const notMine = await api(built.url, '/api/guard/approvals', { token: tokenPuesto });
    assert.ok(!notMine.data.approvals.some((a) => a.approvalId === 'apr-1'), 'otro puesto no la ve');

    const ok = await api(built.url, '/api/guard/approvals/apr-1', { method: 'POST', token, body: { approve: true } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.ok, true);
    const sent = ctl.approvals.at(-1);
    assert.equal(sent.approvalId, 'apr-1');
    assert.equal(sent.approve, true);
    assert.equal(sent.requestedBy.username, 'guardia');
    assert.deepEqual(sent.permissions, PERMS);

    built.hub.ingestFromController('ctl-a', {
      events: [{ seq: 302, ts: t + 5, doorId: 'p2', side: 'in', type: 'approval_resolved', decision: 'grant', reason: 'apertura_manual', payload: { approvalId: 'apr-1' } }]
    });
    const after = await api(built.url, '/api/guard/approvals', { token });
    assert.ok(!after.data.approvals.some((a) => a.approvalId === 'apr-1'));
    const again = await api(built.url, '/api/guard/approvals/apr-1', { method: 'POST', token, body: { approve: false } });
    assert.equal(again.status, 404);
  });

  it('1.3b: rechazar se reenvía y el estanco ocupado responde 409', async () => {
    const t = Date.now();
    built.hub.ingestFromController('ctl-a', {
      events: [
        { seq: 401, ts: t, doorId: 'p1', side: 'in', type: 'approval_pending', decision: 'needs_approval', reason: 'requiere_aprobacion_guardia', payload: { approvalId: 'apr-2' } },
        { seq: 402, ts: t + 1, doorId: 'p1', side: 'in', type: 'approval_pending', decision: 'needs_approval', reason: 'requiere_aprobacion_guardia', payload: { approvalId: 'apr-3' } }
      ]
    });
    const no = await api(built.url, '/api/guard/approvals/apr-2', { method: 'POST', token, body: { approve: false } });
    assert.equal(no.status, 200);
    assert.equal(no.data.message, 'Ingreso rechazado.');
    assert.equal(ctl.approvals.at(-1).approve, false);

    ctl.approvalResponse = { status: 409, ok: false, code: 'AIRLOCK_OTHER_OPEN', message: 'La otra puerta del estanco está abierta.', forcible: true };
    const busy = await api(built.url, '/api/guard/approvals/apr-3', { method: 'POST', token, body: { approve: true } });
    ctl.approvalResponse = null;
    assert.equal(busy.status, 409);
    assert.equal(busy.data.code, 'AIRLOCK_OTHER_OPEN');
    assert.match(busy.data.message, /estanco/);
  });
});
