'use strict';

/**
 * Etapa 2 · Hito 1 — prueba de aceptación de punta a punta (nube real en proceso + hub real +
 * controlador real, todo por HTTP en puertos efímeros, SQLite en archivos temporales):
 *
 *   nube  = functions/app.js completa sobre el Firestore en memoria con contadores
 *           (helpers/countingFirestore.js), firebase-admin auth stub
 *   hub   = scripts/edge/hub (startHub, loops manuales para que sea determinístico)
 *   ctl   = scripts/edge/controller (Controller + API LAN firmada), salida SR201 con TCP
 *           simulado y lector en modo stdin (stream en memoria)
 *
 * (a) config nube → hub → controlador (mismas versiones, clave HMAC incluida)
 * (b) DNI autorizado abre (pulso SR201), desconocido niega
 * (c) evento → journal de la nube + proyección `entries` exactamente una vez aun con reintentos
 * (d) sin internet: decide y acumula; al volver se drena sin duplicados
 * (e) hub caído: el controlador decide; al volver el hub se drena
 * (f) apertura remota nube → hub → controlador con resultado 'done'
 * (g) cambio de permisos en la nube (baja de autorización + markDirty) → el próximo DNI se niega
 * Imprime lecturas/escrituras de Firestore por fase y del escenario completo.
 *
 * Correr solo: `npm run test:e2e` (Node 20 en Windows, necesita better-sqlite3 en scripts/).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { startEdgeCloud } = require('./helpers/edgeCloudHarness');
const { defaultRoleDocs, signTestToken, TEST_JWT_SECRET } = require('./helpers/routeHarness');

const EDGE = path.resolve(__dirname, '../../scripts/edge');

let skip = false;
try {
  const { resolveDriverName } = require(path.join(EDGE, 'lib/db'));
  if (!resolveDriverName()) skip = 'sin driver SQLite (instalar better-sqlite3 en scripts/)';
} catch (err) {
  skip = `scripts/edge no disponible: ${err.message}`;
}

const SITE = 'principal';
const DOOR = 'puerta-p1';
const DNI_OK = '30111222';
const DNI_UNKNOWN = '99999999';

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const waitFor = async (fn, { ms = 8000, step = 25, what = 'condición' } = {}) => {
  const end = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout esperando ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, step));
  }
};

describe('Etapa 2 · Hito 1: nube ⇄ hub ⇄ controlador de punta a punta', { skip, timeout: 120000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-'));
  const adminToken = signTestToken({ id: 'admin', role: 'admin', username: 'admin' });
  const opsByPhase = [];
  let cloud;
  let hubMod;
  let ctlMod;
  let hub = null;
  let hubCfg;
  let hubId;
  let ctlId;
  let controller;
  let ctlLan;
  let readerStream;
  const relayCmds = [];

  const phase = async (name, fn) => {
    const r0 = cloud.fs.stats.reads;
    const w0 = cloud.fs.stats.writes;
    await fn();
    opsByPhase.push({ fase: name, lecturas: cloud.fs.stats.reads - r0, escrituras: cloud.fs.stats.writes - w0 });
  };

  const ctlEvents = (type) => controller.edge.db.all('SELECT id FROM events ORDER BY seq')
    .map((r) => controller.edge.journal.get(r.id))
    .filter((e) => !type || e.type === type);

  /** DNI por el lector (stream tipo stdin) → espera el evento de acceso del controlador. */
  const scan = async (dni) => {
    const before = ctlEvents('access').length;
    readerStream.write(`${dni}\r\n`);
    await waitFor(() => ctlEvents('access').length > before, { what: `decisión del DNI ${dni}` });
    return ctlEvents('access').at(-1);
  };

  const relayOns = () => relayCmds.filter((c) => c.cmd === '11').length;

  const startTheHub = async () => {
    hub = await hubMod.startHub(hubCfg, { loops: false, log: quiet });
    return hub;
  };

  const cloudEntries = () => cloud.fs.paths('entries/').map((p) => cloud.fs.peek(p)).filter((e) => e && e.edge);
  const journalEvents = () => cloud.fs.paths(`sites/${SITE}/journal/`)
    .flatMap((p) => (cloud.fs.peek(p).events || []));

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    delete process.env.EDGE_SIGNING_PRIVATE_KEY;
    cloud = await startEdgeCloud({
      initial: {
        roles: defaultRoleDocs(),
        users: { admin: { username: 'admin', role: 'admin', active: true, passwordVersion: 1, permissions: [] } },
        [`sites/${SITE}`]: { name: 'Banco', tz: 'America/Argentina/Buenos_Aires' },
        people: {
          ana: { nombre: 'Ana Prueba', dniNormalized: DNI_OK, active: true, allowedDoorIds: [DOOR] }
        },
        authorizations: {
          a_ana: { type: 'permanent', personId: 'ana', active: true }
        },
        'settings/accessControl': {}
      }
    });
    hubMod = require(path.join(EDGE, 'hub'));
    ctlMod = require(path.join(EDGE, 'controller/controller.js'));
  });

  after(async () => {
    try { if (controller) { await controller.stop(); controller.close(); } } catch (_) { /* */ }
    if (ctlLan) await new Promise((r) => { ctlLan.close(() => r()); ctlLan.closeAllConnections(); });
    try { if (hub) await hub.stop(); } catch (_) { /* */ }
    if (cloud) await cloud.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* Windows: archivo en uso */ }
    const total = cloud ? { lecturas: cloud.fs.stats.reads, escrituras: cloud.fs.stats.writes } : null;
    // eslint-disable-next-line no-console
    console.log(`\n[e2e] operaciones Firestore por fase:\n${opsByPhase.map((p) => `  ${p.fase.padEnd(34)} R=${String(p.lecturas).padStart(4)} W=${String(p.escrituras).padStart(4)}`).join('\n')}\n  ${'TOTAL escenario'.padEnd(34)} R=${String(total && total.lecturas).padStart(4)} W=${String(total && total.escrituras).padStart(4)}\n`);
  });

  it('alta y enrolamiento de hub y controlador por la API de admin', async () => {
    await phase('alta + enrolamiento', async () => {
      const { generateKeyPair } = require(path.join(EDGE, 'hub/keys'));
      const hubKeys = generateKeyPair();
      const ctlKeys = generateKeyPair();
      const mk = async (body) => {
        const r = await cloud.request('POST', '/api/admin/devices', { token: adminToken, body: { siteId: SITE, ...body } });
        assert.equal(r.status, 201, r.text);
        return r.body;
      };
      const hubDev = await mk({ kind: 'hub', name: 'Hub banco' });
      const ctlDev = await mk({ kind: 'controller', name: 'Controlador banco', doorIds: [DOOR] });
      const enroll = async (code, keys, kind) => {
        const r = await cloud.request('POST', '/api/edge/v1/enroll', { body: { code, publicKey: keys.publicKeyRaw, kind, hostname: 'pc-banco' } });
        assert.equal(r.status, 201, r.text);
        return r.body;
      };
      const hubEnroll = await enroll(hubDev.enrollment.code, hubKeys, 'hub');
      const ctlEnroll = await enroll(ctlDev.enrollment.code, ctlKeys, 'controller');
      hubId = hubEnroll.deviceId;
      ctlId = ctlEnroll.deviceId;
      assert.equal(cloud.fs.peek(`devices/${hubId}`).status, 'active');

      // La puerta se asigna al controlador (Admin de puertas; hoy settings/doorsConfig).
      cloud.fs.poke('settings/doorsConfig', {
        version: 1,
        doors: [{
          id: DOOR,
          name: 'Puerta P1 banco',
          active: true,
          controllerId: ctlId,
          pulseSeconds: 1,
          readers: [{ id: 'INGRESO_P1', direction: 'ingreso' }, { id: 'EGRESO_P1', direction: 'egreso' }]
        }]
      });

      const { getSigningPublicKey } = require('../lib/siteCompiler');
      const signing = getSigningPublicKey();
      const headPublicKeys = { [signing.keyId]: signing.publicKeyPem };
      const [hubPort, ctlPort] = [await freePort(), await freePort()];
      const hubUrl = `http://127.0.0.1:${hubPort}`;
      const ctlUrl = `http://127.0.0.1:${ctlPort}`;

      hubCfg = hubMod.normalizeConfig({
        deviceId: hubId,
        siteId: SITE,
        privateKey: hubKeys.privateKeyPem,
        dataDir: path.join(tmp, 'hub'),
        lan: { host: '127.0.0.1', port: hubPort },
        cloud: { baseUrl: `${cloud.baseUrl}/api`, refreshToken: hubEnroll.refreshToken, headPublicKeys, timeoutMs: 2000 },
        controllers: [{ deviceId: ctlId, publicKey: ctlKeys.publicKeyRaw, url: ctlUrl }]
      });
      fs.mkdirSync(hubCfg.dataDir, { recursive: true });

      const { normalizeConfig } = require(path.join(EDGE, 'controller/config.js'));
      const { createLanServer } = require(path.join(EDGE, 'controller/lanApi.js'));
      const ctlDir = path.join(tmp, 'ctl');
      fs.mkdirSync(ctlDir, { recursive: true });
      const ctlCfg = normalizeConfig({
        deviceId: ctlId,
        siteId: SITE,
        dataDir: ctlDir,
        hub: { url: hubUrl, deviceId: hubId, publicKey: hubKeys.publicKeyPem, heartbeatMs: 200, configPollMs: 10 * 60 * 1000, timeoutMs: 2000 },
        cloud: { headPublicKeys },
        lan: { port: ctlPort, bind: '127.0.0.1' },
        clock: { trusted: true },
        cooldownMs: 0,
        doors: [{
          id: DOOR,
          readers: [{ id: 'p1-stdin', driver: 'stdin', side: 'in', idleMs: 30, interFrameGapMs: 20 }],
          output: { driver: 'sr201', host: '192.168.0.38', port: 6722, channel: 1 },
          inputs: { driver: 'none' }
        }]
      }, ctlDir);
      readerStream = new PassThrough();
      controller = new ctlMod.Controller({
        config: ctlCfg,
        privateKeyPem: ctlKeys.privateKeyPem,
        logger: quiet,
        driverDeps: {
          reader: { stream: readerStream },
          // SR201 real con el TCP simulado (192.168.0.38:6722 canal 1).
          output: {
            sendFn: async (host, port, cmd) => {
              relayCmds.push({ host, port, cmd, at: Date.now() });
              return { confirmed: true, response: cmd.startsWith('1') ? '10000000' : '00000000' };
            },
            sleepFn: async () => {}
          }
        }
      });
      ctlLan = createLanServer({ controller, config: ctlCfg, logger: quiet });
      await new Promise((r) => ctlLan.listen(ctlPort, '127.0.0.1', r));
      await controller.start();
      await startTheHub();
    });
  });

  it('(a) config nube → hub → controlador con la misma versión firmada (y la clave HMAC)', async () => {
    await phase('(a) config inicial', async () => {
      await hub.headSource.pollNow();
      const headDoc = cloud.fs.peek(`sites/${SITE}/compiled/head`);
      assert.ok(headDoc && headDoc.version > 0, 'la nube compiló');
      assert.equal(hub.configSync.configVersion(), headDoc.version);
      assert.ok(headDoc.chunks.secrets, 'el sitio tiene clave de credenciales');
      await waitFor(() => controller.edge.chunks.configVersion() === headDoc.version, { what: 'versión en el controlador' });
      assert.ok(controller.configSync.credentialKey(), 'el controlador recibió la clave HMAC por el hub');
      assert.equal(controller.edge.snapshot.door(DOOR).controllerId, ctlId);
      // ack de versión: controlador → hub → nube (heartbeat) → devices/{ctl}
      await waitFor(() => hub.controllers.summary()[ctlId].configVersionApplied === headDoc.version, { what: 'ack en el hub' });
      await hub.heartbeat();
      assert.equal(cloud.fs.peek(`devices/${ctlId}`).configVersionApplied, headDoc.version);
      assert.equal(cloud.fs.peek(`devices/${hubId}`).configVersionApplied, headDoc.version);
    });
  });

  it('(b) DNI autorizado abre (pulso SR201 canal 1); DNI desconocido niega', async () => {
    await phase('(b) escaneos', async () => {
      const ons = relayOns();
      const ok = await scan(DNI_OK);
      assert.equal(ok.decision, 'grant', ok.reason);
      assert.equal(ok.cardholderId, 'ana');
      assert.equal(ok.payload.relayConfirmed, true);
      assert.equal(relayOns(), ons + 1);
      assert.deepEqual(relayCmds.find((c) => c.cmd === '11'), { ...relayCmds.find((c) => c.cmd === '11'), host: '192.168.0.38', port: 6722 });
      const bad = await scan(DNI_UNKNOWN);
      assert.equal(bad.decision, 'deny');
      assert.equal(bad.reason, 'credencial_desconocida');
      assert.equal(relayOns(), ons + 1, 'el desconocido no pulsa');
    });
  });

  it('(c) el evento llega al journal y a `entries` exactamente una vez, aun con reintentos', async () => {
    await phase('(c) subida + reintentos', async () => {
      const granted = ctlEvents('access').find((e) => e.decision === 'grant');
      await waitFor(() => hub.edge.journal.get(granted.id), { what: 'evento en el hub' });
      // Ack perdido: la nube procesa el lote pero el hub no recibe la respuesta → reintenta el mismo rango.
      const realPost = hub.client.postEvents.bind(hub.client);
      let lost = 0;
      hub.client.postEvents = async (payload) => {
        const r = await realPost(payload);
        if (lost === 0) {
          lost += 1;
          throw Object.assign(new Error('respuesta perdida'), { code: 'NETWORK' });
        }
        return r;
      };
      const first = await hub.uploader.flush({ force: true });
      assert.ok(first.error, 'primer intento sin ack');
      const second = await hub.uploader.flush({ force: true });
      assert.equal(second.error, undefined, JSON.stringify(second));
      hub.client.postEvents = realPost;
      assert.equal(hub.edge.journal.stats().pending, 0);
      // El controlador reenvía lo mismo (reinicio): el hub lo descarta por id.
      const dup = hub.ingestFromController(ctlId, { events: ctlEvents().slice(0, 3) });
      assert.equal(dup.inserted, 0);

      const entries = cloudEntries().filter((e) => e.edge.eventId === granted.id);
      assert.equal(entries.length, 1, 'una sola proyección');
      assert.equal(entries[0].name, 'Ana Prueba', 'el hub agrega el nombre');
      assert.equal(entries[0].doorId, DOOR);
      assert.equal(entries[0].accessAuthorized, true);
      const ids = journalEvents().map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, 'sin duplicados en el journal');
      assert.ok(ids.includes(granted.id));
      assert.ok(ids.some((id) => ctlEvents('access').find((e) => e.decision === 'deny' && e.id === id)), 'el rechazo también queda en el journal');
    });
  });

  it('(d) sin internet decide y acumula; al volver se drena sin duplicados', async () => {
    await phase('(d) corte de internet', async () => {
      const entriesBefore = cloudEntries().length;
      await cloud.stop();
      const g1 = await scan(DNI_OK);
      const d1 = await scan(DNI_UNKNOWN);
      const g2 = await scan(DNI_OK);
      assert.equal(g1.decision, 'grant');
      assert.equal(d1.decision, 'deny');
      assert.equal(g2.decision, 'grant');
      assert.equal(g2.reason, 'lectura_repetida', 'el mismo DNI a los pocos segundos es el mismo paso');
      await waitFor(() => hub.edge.journal.get(g2.id), { what: 'eventos en el hub sin internet' });
      const offline = await hub.uploader.flush({ force: true });
      assert.ok(offline.error, 'sin nube no sube');
      assert.ok(hub.edge.journal.stats().pending >= 3);
      await hub.heartbeat(); // tampoco rompe
      await cloud.restart();
      const back = await hub.uploader.flush({ force: true });
      assert.equal(back.error, undefined, JSON.stringify(back));
      assert.equal(hub.edge.journal.stats().pending, 0);
      // g1 puede ser a su vez lectura repetida del paso de la fase (c) (mismo DNI hace < 15 s).
      const nuevosPasos = g1.reason === 'lectura_repetida' ? 0 : 1;
      assert.equal(cloudEntries().length, entriesBefore + nuevosPasos, 'la lectura repetida no crea otro doc');
      const ids = journalEvents().map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length);
      for (const e of [g1, d1, g2]) assert.ok(ids.includes(e.id), `falta ${e.id}`);
    });
  });

  it('(e) hub caído: el controlador decide solo; al volver el hub se drena', async () => {
    await phase('(e) hub caído', async () => {
      const entriesBefore = cloudEntries().length;
      await hub.stop();
      hub = null;
      // El paso anterior quedó hace un instante: se corre el ancla para que este DNI sea un paso nuevo.
      for (const [key, prev] of controller.lastPassage) {
        controller.lastPassage.set(key, { ...prev, at: prev.at - 60000 });
      }
      const g = await scan(DNI_OK);
      const d = await scan(DNI_UNKNOWN);
      assert.equal(g.decision, 'grant');
      assert.notEqual(g.reason, 'lectura_repetida');
      assert.equal(d.decision, 'deny');
      assert.ok(controller.edge.journal.stats().pending >= 2, 'quedan en el controlador');
      await startTheHub(); // misma base: refresh token rotado persistido
      await waitFor(async () => {
        await controller.pusher.pushOnce();
        return controller.edge.journal.stats().pending === 0;
      }, { what: 'drenado controlador → hub', ms: 10000, step: 100 });
      assert.ok(hub.edge.journal.get(g.id));
      const up = await hub.uploader.flush({ force: true });
      assert.equal(up.error, undefined, JSON.stringify(up));
      assert.equal(cloudEntries().length, entriesBefore + 1);
      const ids = journalEvents().map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length);
    });
  });

  it('(f) apertura remota desde la nube → hub → controlador, resultado done', async () => {
    await phase('(f) apertura remota', async () => {
      const ons = relayOns();
      const r = await cloud.request('POST', `/api/guard/doors/${DOOR}/remote-open`, { token: adminToken, body: { reason: 'proveedor en portón' } });
      assert.equal(r.status, 202, r.text);
      const id = r.body.command.id;
      await hub.headSource.pollNow(); // head trae pendingCommands > 0 → el hub consulta comandos
      await waitFor(async () => {
        if (hub.commands.running) await hub.commands.running;
        const c = await cloud.request('GET', `/api/guard/commands/${id}`, { token: adminToken });
        return c.body.command.status !== 'pending' ? c : null;
      }, { what: 'resultado del comando' });
      const c = await cloud.request('GET', `/api/guard/commands/${id}`, { token: adminToken });
      assert.equal(c.body.command.status, 'done', JSON.stringify(c.body.command));
      assert.equal(c.body.command.result.relayConfirmed, true);
      assert.equal(relayOns(), ons + 1);
      const ev = ctlEvents('remote_open').at(-1);
      assert.equal(ev.decision, 'grant');
      assert.equal(ev.payload.commandId, id);
      const head = await hub.client.getHead();
      assert.equal(head.pendingCommands, 0, 'contador vuelto a 0');
    });
  });

  it('(g) baja de la autorización en la nube → el próximo DNI se niega', async () => {
    await phase('(g) cambio de permisos', async () => {
      const v0 = controller.edge.chunks.configVersion();
      const del = await cloud.request('DELETE', '/api/admin/authorizations/a_ana', { token: adminToken });
      assert.equal(del.status, 200, del.text);
      await waitFor(() => cloud.fs.peek(`sites/${SITE}/compiled/_dirty`), { what: 'markDirty' });
      await hub.headSource.pollNow();
      assert.ok(hub.configSync.configVersion() > v0, 'nueva versión en el hub');
      await waitFor(() => controller.edge.chunks.configVersion() === hub.configSync.configVersion(), { what: 'nueva versión en el controlador' });
      const ons = relayOns();
      const r = await scan(DNI_OK);
      assert.equal(r.decision, 'deny', r.reason);
      assert.equal(relayOns(), ons);
    });
  });
});
