const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

const user = (role, extra = {}) => ({
  username: extra.username || role,
  role,
  active: true,
  passwordVersion: 1,
  permissions: [],
  ...extra
});

/** Cuenta lecturas/escrituras de Firestore sobre el db en memoria (in place). */
const instrument = (db) => {
  const counter = { reads: 0, writes: 0 };
  const raw = (ref) => ref._raw || ref;
  const wrapRef = (ref) => ({
    ...ref,
    _raw: ref,
    async get() { counter.reads += 1; return ref.get(); },
    async set(...a) { counter.writes += 1; return ref.set(...a); },
    async update(...a) { counter.writes += 1; return ref.update(...a); },
    async delete() { counter.writes += 1; return ref.delete(); },
    collection: (sub) => wrapCol(ref.collection(sub))
  });
  function wrapCol(col) {
    return {
      ...col,
      doc: (id) => wrapRef(col.doc(id)),
      async get() { const r = await col.get(); counter.reads += Math.max(1, r.size); return r; }
    };
  }
  const origCollection = db.collection;
  const origBatch = db.batch;
  const origTx = db.runTransaction;
  db.collection = (name) => wrapCol(origCollection(name));
  db.batch = () => {
    const b = origBatch();
    return {
      set: (ref, p, o) => { counter.writes += 1; b.set(raw(ref), p, o); },
      update: (ref, p) => { counter.writes += 1; b.update(raw(ref), p); },
      delete: (ref) => { counter.writes += 1; b.delete(raw(ref)); },
      commit: () => b.commit()
    };
  };
  db.runTransaction = (fn) => origTx((tx) => fn({
    get: (ref) => { counter.reads += 1; return tx.get(raw(ref)); },
    set: (ref, p, o) => { counter.writes += 1; tx.set(raw(ref), p, o); },
    update: (ref, p) => { counter.writes += 1; tx.update(raw(ref), p); },
    delete: (ref) => { counter.writes += 1; tx.delete(raw(ref)); }
  }));
  return {
    counter,
    reset() { counter.reads = 0; counter.writes = 0; }
  };
};

const ev = (n, extra = {}) => ({
  id: `ctl-a:${n}`,
  seq: n,
  hubSeq: n,
  ts: Date.UTC(2026, 9, 8, 12, 0, n),
  clockQ: 'ntp',
  deviceId: 'ctl-a',
  doorId: 'p1',
  side: 'in',
  type: 'access',
  credType: 'dni',
  credHash: `h${n}`,
  cardholderId: `per-${n}`,
  decision: 'grant',
  reason: null,
  payload: { name: `Persona ${n}`, idNumberMasked: '***123', relayConfirmed: true, doorOpened: true, matchedSource: 'direct' },
  ...extra
});

describe('Edge: eventos, heartbeat, comandos, head y live', () => {
  let mem;
  let srv;
  let ops;
  let devices;
  let edgeIngest;
  const notifications = [];
  const adminToken = signTestToken({ id: 'admin', role: 'admin', username: 'admin' });
  const guardiaToken = signTestToken({ id: 'guardia', role: 'guardia', username: 'guardia' });
  let hubToken;
  let ctlToken;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs({ sinPermisos: [] }),
        users: {
          admin: user('admin'),
          guardia: user('guardia'),
          mirón: user('sinPermisos')
        },
        devices: {
          'hub-1': { siteId: 'principal', kind: 'hub', name: 'Hub', status: 'active', doorIds: [] },
          'ctl-a': { siteId: 'principal', kind: 'controller', name: 'Pi A', status: 'active', doorIds: ['p1'] }
        },
        settings: {
          doorsConfig: {
            doors: [
              { id: 'p1', name: 'Estanco exterior', controllerId: 'ctl-a' },
              { id: 'legacy', name: 'Portón viejo' }
            ]
          },
          accessControl: {}
        }
      },
      stubs: {
        'lib/notifications/index.js': {
          notifySafe: (type, payload) => notifications.push({ type, payload }),
          onAdminAuditLogged: async () => {}
        }
      }
    });
    ops = instrument(mem.db);
    devices = require('../lib/devices');
    edgeIngest = require('../lib/edgeIngest');
    hubToken = devices.signDeviceToken({ deviceId: 'hub-1', siteId: 'principal', deviceKind: 'hub' });
    ctlToken = devices.signDeviceToken({ deviceId: 'ctl-a', siteId: 'principal', deviceKind: 'controller' });
    srv = await startRouters(['routes/edge.js']);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => {
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
    notifications.length = 0;
    ops.reset();
  });

  const postEvents = (body, token = hubToken) => srv.request('POST', '/api/edge/v1/events', { token, body });
  const journalId = (from, ts) => `${edgeIngest.journalDocId({ hubId: 'hub-1', hubSeqFrom: from, firstTs: ts })}`;

  it('lote idempotente: mismo lote dos veces → un doc de journal y el mismo ack', async () => {
    const events = [ev(1), ev(2, { decision: 'deny', reason: 'puerta_no_autorizada' }), ev(3)];
    const body = { hubId: 'hub-1', events, hubSeqFrom: 1, hubSeqTo: 3 };
    const first = await postEvents(body);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.ackHubSeq, 3);
    assert.equal(first.body.duplicate, false);
    const jid = journalId(1, events[0].ts);
    assert.equal(first.body.journalId, jid);
    assert.equal(jid, '20261008_hub-1_1');
    const journal = mem.getDoc('sites/principal/journal', jid);
    assert.equal(journal.events.length, 3);
    assert.equal(journal.hubSeqTo, 3);

    const second = await postEvents(body);
    assert.equal(second.status, 200);
    assert.equal(second.body.ackHubSeq, 3);
    assert.equal(second.body.duplicate, true);
    assert.equal(mem.getDoc('sites/principal/status', 'hub').ackHubSeq, 3);
  });

  it('lectura_repetida no crea otro doc en entries', async () => {
    const events = [
      ev(30, { reason: 'puerta_directa', cardholderId: 'ana' }),
      ev(31, { reason: 'lectura_repetida', cardholderId: 'ana', payload: { repeatOf: 'ctl-a:30', name: 'Ana' } })
    ];
    const res = await postEvents({ hubId: 'hub-1', events, hubSeqFrom: 30, hubSeqTo: 31 });
    assert.equal(res.status, 200, res.text);
    assert.ok(mem.hasDoc('entries', 'edge_hub-1_ctl-a_30'));
    assert.ok(!mem.hasDoc('entries', 'edge_hub-1_ctl-a_31'), 'la lectura repetida no se proyecta');
  });

  it('proyección a entries solo para autorizados, con campos compat del libro', async () => {
    assert.ok(mem.hasDoc('entries', 'edge_hub-1_ctl-a_1'));
    assert.ok(!mem.hasDoc('entries', 'edge_hub-1_ctl-a_2'), 'el denegado no se proyecta');
    assert.ok(mem.hasDoc('entries', 'edge_hub-1_ctl-a_3'));
    const entry = mem.getDoc('entries', 'edge_hub-1_ctl-a_1');
    assert.equal(entry.type, 'personal');
    assert.equal(entry.tipoMovimiento, 'ingreso');
    assert.equal(entry.name, 'Persona 1');
    assert.equal(entry.idNumber, '***123');
    assert.equal(entry.doorId, 'p1');
    assert.equal(entry.accessAuthorized, true);
    assert.equal(entry.entrySource, 'edge');
    assert.equal(entry.relayConfirmed, true);
    assert.equal(entry.personId, 'per-1');
    assert.equal(entry.edge.eventId, 'ctl-a:1');
    assert.ok(entry.timestamp);
  });

  it('1b: el paso de una visita la marca "ingreso_registrado" con hora; cancelada no se toca', async () => {
    mem.setDoc('visitas', 'vis-1', { estado: 'autorizada', nombreVisitante: 'Juan Visita' });
    mem.setDoc('visitas', 'vis-2', { estado: 'autorizada', passCode: 'QR-2' });
    mem.setDoc('visitas', 'vis-3', { estado: 'cancelada', passCode: 'QR-3' });
    const visit = (n, payload, extra = {}) => ev(n, { cardholderId: null, credType: 'qr', payload: { name: 'Visita', ...payload }, ...extra });
    const events = [
      visit(60, { passId: 'QR-1', visitaId: 'vis-1', doorName: 'Ingreso Principal' }),
      visit(61, { passId: 'QR-2' }),
      visit(62, { passId: 'QR-3' }),
      visit(63, { passId: 'QR-1', visitaId: 'vis-1' }, { decision: 'deny', reason: 'fuera_de_horario' })
    ];
    const res = await postEvents({ hubId: 'hub-1', events, hubSeqFrom: 60, hubSeqTo: 63 });
    assert.equal(res.status, 200, res.text);
    const v1 = mem.getDoc('visitas', 'vis-1');
    assert.equal(v1.estado, 'ingreso_registrado');
    assert.equal(v1.ingresoDoorName, 'Ingreso Principal');
    assert.ok(v1.ingresoAt, 'guarda la hora de ingreso');
    assert.equal(mem.getDoc('visitas', 'vis-2').estado, 'ingreso_registrado', 'se encuentra por passCode');
    assert.equal(mem.getDoc('visitas', 'vis-3').estado, 'cancelada');

    const firstAt = v1.ingresoAt;
    const out = await postEvents({ hubId: 'hub-1', events: [visit(64, { passId: 'QR-1', visitaId: 'vis-1' }, { side: 'out' })], hubSeqFrom: 64, hubSeqTo: 64 });
    assert.equal(out.status, 200, out.text);
    const after = mem.getDoc('visitas', 'vis-1');
    assert.equal(after.estado, 'egreso_registrado');
    assert.deepEqual(after.ingresoAt, firstAt, 'la hora de ingreso no se pisa');
    assert.ok(after.egresoAt);
  });

  it('presupuesto: 1 lectura + (1 + entries + alarmas + 1) escrituras; duplicado = 1 lectura y 0 escrituras', async () => {
    const events = [
      ev(10),
      ev(11, { side: 'out' }),
      ev(12, { decision: 'deny', reason: 'fuera_horario_turno' }),
      ev(13, { type: 'held_open', decision: null, cardholderId: null }),
      ev(14, { type: 'duress', decision: 'grant' }),
      ev(15, { type: 'heartbeat_gap', decision: null })
    ];
    const body = { hubId: 'hub-1', events, hubSeqFrom: 10, hubSeqTo: 15 };
    ops.reset();
    const res = await postEvents(body);
    assert.equal(res.status, 200, res.text);
    const granted = 2;
    const alarms = 2;
    assert.equal(ops.counter.reads, 1);
    assert.equal(ops.counter.writes, 1 + granted + alarms + 1);

    ops.reset();
    const dup = await postEvents(body);
    assert.equal(dup.body.duplicate, true);
    assert.equal(ops.counter.reads, 1);
    assert.equal(ops.counter.writes, 0);
    assert.equal(mem.getDoc('entries', 'edge_hub-1_ctl-a_11').tipoMovimiento, 'egreso');
  });

  it('alarma de coacción → doc de alarma + mail (duress_access); held_open sin mail', async () => {
    const events = [
      ev(20, { type: 'duress', payload: { name: 'Ana', alarmId: 'al-duress-1' } }),
      ev(21, { type: 'held_open', decision: null })
    ];
    const res = await postEvents({ hubId: 'hub-1', events, hubSeqFrom: 20, hubSeqTo: 21 });
    assert.equal(res.status, 200, res.text);
    const alarm = mem.getDoc('sites/principal/alarms', 'al-duress-1');
    assert.equal(alarm.type, 'duress');
    assert.equal(alarm.state, 'active');
    assert.equal(alarm.critical, true);
    assert.ok(mem.hasDoc('sites/principal/alarms', 'hub-1_held_open_p1'));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'duress_access');
    assert.equal(notifications[0].payload.name, 'Ana');
    assert.equal(notifications[0].payload.doorId, 'p1');
    assert.ok(!mem.hasDoc('entries', 'edge_hub-1_ctl-a_20'), 'la alarma no proyecta entry');
  });

  it('alarma con la forma del controlador (type alarm + reason + state raised/cleared) → mismo doc', async () => {
    notifications.length = 0;
    const raised = ev(25, { type: 'alarm', reason: 'door_forced', decision: null, cardholderId: null, payload: { state: 'raised', detail: 'dps_abierto' } });
    const res = await postEvents({ hubId: 'hub-1', events: [raised], hubSeqFrom: 25, hubSeqTo: 25 });
    assert.equal(res.status, 200, res.text);
    const id = 'hub-1_door_forced_p1';
    assert.equal(mem.getDoc('sites/principal/alarms', id).type, 'door_forced');
    assert.equal(mem.getDoc('sites/principal/alarms', id).state, 'active');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'edge_alarm');
    assert.equal(notifications[0].payload.alarmType, 'door_forced');
    const cleared = ev(26, { type: 'alarm', reason: 'door_forced', decision: null, cardholderId: null, payload: { state: 'cleared' } });
    await postEvents({ hubId: 'hub-1', events: [cleared], hubSeqFrom: 26, hubSeqTo: 26 });
    assert.equal(mem.getDoc('sites/principal/alarms', id).state, 'cleared');
    assert.equal(notifications.length, 1, 'el cleared no manda mail');
  });

  it('eventos: solo hub, hubId coherente, ≤200 eventos y secuencia válida', async () => {
    const body = { hubId: 'hub-1', events: [ev(30)], hubSeqFrom: 30, hubSeqTo: 30 };
    assert.equal((await postEvents(body, ctlToken)).status, 403);
    assert.equal((await postEvents(body, adminToken)).status, 401);
    assert.equal((await postEvents({ ...body, hubId: 'otro' })).status, 403);
    const many = Array.from({ length: 201 }, (_, i) => ev(100 + i));
    assert.equal((await postEvents({ hubId: 'hub-1', events: many, hubSeqFrom: 100, hubSeqTo: 300 })).status, 400);
    assert.equal((await postEvents({ ...body, hubSeqFrom: 5, hubSeqTo: 4 })).status, 400);
    assert.equal((await postEvents({ ...body, events: [{ id: 'x' }] })).status, 400);
  });

  it('heartbeat: escribe solo si cambió algo o pasaron 5 min; el hub publica lanUrl en el sitio', async () => {
    const hb = (token, body) => srv.request('POST', '/api/edge/v1/heartbeat', { token, body });
    const first = await hb(ctlToken, { configVersionApplied: 7, checks: { serial: 'ok' } });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.wrote, true);
    ops.reset();
    const same = await hb(ctlToken, { configVersionApplied: 7, checks: { serial: 'ok' } });
    assert.equal(same.body.wrote, false);
    assert.equal(ops.counter.writes, 0);
    assert.equal(ops.counter.reads, 1);
    const changed = await hb(ctlToken, { configVersionApplied: 8, checks: { serial: 'ok' } });
    assert.equal(changed.body.wrote, true);
    // > 5 min sin escribir → escribe aunque nada cambie
    mem.setDoc('devices', 'ctl-a', { ...mem.getDoc('devices', 'ctl-a'), lastSeenAt: Date.now() - 6 * 60 * 1000 });
    assert.equal((await hb(ctlToken, { configVersionApplied: 8, checks: { serial: 'ok' } })).body.wrote, true);
    // el controlador no publica lanUrl
    await hb(ctlToken, { configVersionApplied: 8, checks: { serial: 'ok' }, lanUrl: 'http://10.0.0.9:8080' });
    assert.equal(mem.getDoc('sites', 'principal')?.lanUrl, undefined);

    const hub = await hb(hubToken, { configVersionApplied: 8, checks: {}, lanUrl: 'http://192.168.0.10:8080' });
    assert.equal(hub.status, 200);
    assert.equal(hub.body.siteWrote, true);
    assert.equal(mem.getDoc('sites', 'principal').lanUrl, 'http://192.168.0.10:8080');
    const hubAgain = await hb(hubToken, { configVersionApplied: 8, checks: {}, lanUrl: 'http://192.168.0.10:8080' });
    assert.equal(hubAgain.body.siteWrote, false);
    assert.equal(hubAgain.body.wrote, false);

    assert.equal((await hb(hubToken, { lanUrl: 'javascript:alert(1)' })).status, 400);

    mem.setDoc('devices', 'ctl-a', { ...mem.getDoc('devices', 'ctl-a'), status: 'revoked' });
    const revoked = await hb(ctlToken, {});
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.code, 'DEVICE_REVOKED');
    mem.setDoc('devices', 'ctl-a', { ...mem.getDoc('devices', 'ctl-a'), status: 'active' });
  });

  it('apertura remota: comando pendiente → resultado del hub → consulta; puerta legacy 409', async () => {
    const legacy = await srv.request('POST', '/api/guard/doors/legacy/remote-open', { token: guardiaToken, body: {} });
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.code, 'DOOR_NOT_MIGRATED');
    const missing = await srv.request('POST', '/api/guard/doors/nada/remote-open', { token: guardiaToken, body: {} });
    assert.equal(missing.status, 404);
    const noReason = await srv.request('POST', '/api/guard/doors/p1/remote-open', {
      token: guardiaToken,
      body: { forceAirlock: true, forceReason: 'x' }
    });
    assert.equal(noReason.status, 400);

    const created = await srv.request('POST', '/api/guard/doors/p1/remote-open', {
      token: guardiaToken,
      body: { reason: 'proveedor en portón' }
    });
    assert.equal(created.status, 202, created.text);
    const cmd = created.body.command;
    assert.equal(cmd.status, 'pending');
    assert.equal(cmd.doorId, 'p1');
    assert.equal(cmd.force, false);
    const stored = mem.getDoc('sites/principal/commands', cmd.id);
    assert.equal(stored.action, 'open');
    assert.equal(stored.controllerId, 'ctl-a');
    assert.equal(stored.requestedBy.username, 'guardia');
    assert.ok(stored.expiresAt - stored.createdAt === 45000);

    const poll = await srv.request('GET', `/api/guard/commands/${cmd.id}`, { token: guardiaToken });
    assert.equal(poll.body.command.status, 'pending');

    const byCtl = await srv.request('POST', `/api/edge/v1/commands/${cmd.id}/result`, {
      token: ctlToken,
      body: { status: 'done' }
    });
    assert.equal(byCtl.status, 403);

    const result = await srv.request('POST', `/api/edge/v1/commands/${cmd.id}/result`, {
      token: hubToken,
      body: { status: 'done', relayConfirmed: true, doorOpened: true, reason: null }
    });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.command.status, 'done');
    const again = await srv.request('POST', `/api/edge/v1/commands/${cmd.id}/result`, {
      token: hubToken,
      body: { status: 'failed' }
    });
    assert.equal(again.body.command.status, 'done');
    assert.equal(again.body.command.duplicate, true);

    const done = await srv.request('GET', `/api/guard/commands/${cmd.id}`, { token: guardiaToken });
    assert.equal(done.body.command.status, 'done');
    assert.deepEqual(done.body.command.result, { relayConfirmed: true, doorOpened: true, reason: null });

    // Vencido sin respuesta del hub
    const late = await srv.request('POST', '/api/guard/doors/p1/remote-open', {
      token: guardiaToken,
      body: { forceAirlock: true, forceReason: 'evacuación del estanco' }
    });
    assert.equal(late.status, 202);
    assert.equal(late.body.command.force, true);
    const lateId = late.body.command.id;
    mem.setDoc('sites/principal/commands', lateId, { ...mem.getDoc('sites/principal/commands', lateId), expiresAt: Date.now() - 1 });
    const expired = await srv.request('GET', `/api/guard/commands/${lateId}`, { token: guardiaToken });
    assert.equal(expired.body.command.status, 'expired');

    const noPerm = await srv.request('POST', '/api/guard/doors/p1/remote-open', {
      token: signTestToken({ id: 'mirón', role: 'sinPermisos' }),
      body: {}
    });
    assert.equal(noPerm.status, 403);
  });

  it('head/chunks vía adaptador del compilador; 503 si no está; chunks solo hub', async () => {
    edgeIngest.setSiteCompilerForTests(null);
    const unavailable = await srv.request('GET', '/api/edge/v1/head', { token: ctlToken });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.message, 'compilador no disponible');

    const calls = [];
    edgeIngest.setSiteCompilerForTests({
      getHead: async (siteId) => ({ version: 42, chunks: { doors: { v: 3, hash: 'abc' } }, sig: 'sig', keyId: 'k1', siteId }),
      getChunks: async (siteId, names) => { calls.push({ siteId, names }); return Object.fromEntries(names.map((n) => [n, { name: n }])); },
      getSigningPublicKey: async () => ({ keyId: 'k1', publicKey: '-----BEGIN PUBLIC KEY-----x' }),
      compileSite: async () => ({})
    });
    const head = await srv.request('GET', '/api/edge/v1/head', { token: ctlToken });
    assert.equal(head.status, 200, head.text);
    assert.equal(head.body.head.version, 42);
    assert.equal(head.body.keyId, 'k1');

    const chunks = await srv.request('GET', '/api/edge/v1/chunks?names=doors,ch-01,doors', { token: hubToken });
    assert.equal(chunks.status, 200);
    assert.deepEqual(Object.keys(chunks.body.chunks), ['doors', 'ch-01']);
    assert.deepEqual(calls[0], { siteId: 'principal', names: ['doors', 'ch-01'] });
    assert.equal((await srv.request('GET', '/api/edge/v1/chunks?names=doors', { token: ctlToken })).status, 403);
    assert.equal((await srv.request('GET', '/api/edge/v1/chunks?names=../x', { token: hubToken })).status, 400);
    edgeIngest.setSiteCompilerForTests(undefined);
  });

  it('live: el hub publica el resumen y la vista remota lo lee con caché de 15 s', async () => {
    const put = await srv.request('POST', '/api/edge/v1/live', { token: hubToken, body: { summary: { inside: 12 } } });
    assert.equal(put.status, 200, put.text);
    assert.equal((await srv.request('POST', '/api/edge/v1/live', { token: ctlToken, body: {} })).status, 403);

    const get = await srv.request('GET', '/api/sites/principal/live', { token: guardiaToken });
    assert.equal(get.status, 200, get.text);
    assert.deepEqual(get.body.summary, { inside: 12 });

    await srv.request('POST', '/api/edge/v1/live', { token: hubToken, body: { summary: { inside: 13 } } });
    await srv.request('GET', '/api/sites/principal/live', { token: adminToken });
    ops.reset();
    const cached = await srv.request('GET', '/api/sites/principal/live', { token: adminToken });
    assert.deepEqual(cached.body.summary, { inside: 12 }, 'dentro de los 15 s sale de la caché');
    assert.equal(ops.counter.reads, 0);
  });
});
