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
    assert.deepEqual(runtime.data.capabilities, ['auth', 'doors', 'open', 'entries', 'alarms', 'live', 'scan']);
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
});
