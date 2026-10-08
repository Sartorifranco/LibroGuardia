'use strict';

/**
 * Fixture de los tests del controlador (no es un test): bundle firmado por una "nube" de prueba,
 * hub falso en memoria y un Controller armado sobre SQLite temporal con salidas mock y reloj manual.
 */

const path = require('path');
const { hashCredential } = require('../../../functions/lib/accessEngine');
const lanSign = require('../lib/lanSign');
const { openEdgeDb } = require('../lib/db');
const { hashBody } = require('../lib/db/chunkStore');
const { SKIP, tmpDir, rmDir } = require('../lib/db/_testkit');
const { MockOutput } = require('../drivers/outputs');
const { normalizeConfig } = require('./config');
const { Controller } = require('./controller');
const { EdgeClock } = require('./hubClient');
const { createFakeClock } = require('./_testkit');

const DEVICE = 'ctl-test';
const DNI = { ana: '30111222', beto: '30222333', carlos: '30333444' };

function siteBodies({ interlockMode = 'sensor' } = {}) {
  const door = (id, name, extra = {}) => ({
    id, name, enabled: true, sides: ['in', 'out'], controllerId: DEVICE, unlockSec: 3, heldOpenSec: 10,
    readers: [{ id: `${id}-in`, side: 'in' }, { id: `${id}-out`, side: 'out' }], ...extra
  });
  const cred = (dni) => [{ type: 'dni', valueHash: hashCredential('dni', dni), status: 'active' }];
  return {
    doors: {
      site: { id: 'principal', tz: 'America/Argentina/Buenos_Aires' },
      policy: {},
      doors: [door('p1', 'Exterior'), door('p2', 'Interior'), door('p3', 'Con aprobación', { requireGuardApproval: true })],
      schedules: [{ id: '24x7', always: true }],
      interlockGroups: [{ id: 'est1', doorIds: ['p1', 'p2'], outerDoorId: 'p1', mode: interlockMode }],
      accessGroups: [{ id: 'grp_total', doors: '*', scheduleId: '24x7' }]
    },
    'ch-00': {
      bucket: 0,
      cardholders: [
        { id: 'ana', status: 'active', name: 'Ana', accessLevels: ['grp_total'], credentials: cred(DNI.ana) },
        { id: 'beto', status: 'active', name: 'Beto', credentials: cred(DNI.beto) },
        { id: 'carlos', status: 'inactive', name: 'Carlos', accessLevels: ['grp_total'], credentials: cred(DNI.carlos) }
      ]
    }
  };
}

function makeHead(version, bodies) {
  const chunks = {};
  for (const [name, body] of Object.entries(bodies)) chunks[name] = { v: version, hash: hashBody(body) };
  return { version, chunks };
}

/** Hub en memoria: sirve head + chunks y recibe eventos. `down=true` simula hub caído. */
function createFakeHub(cloud) {
  const hub = {
    head: null,
    bodies: {},
    down: false,
    pushFailures: 0,
    received: [],
    ackMode: 'all',
    lastOkAt: null,
    lastError: null,
    publish(version, bodies, { sign = true, tamper = false } = {}) {
      let head = makeHead(version, bodies);
      if (sign) head = lanSign.signHead(head, cloud.privateKeyPem, 'k1');
      // Hub comprometido: altera el head ya firmado (p. ej. para colar un chunk propio).
      if (tamper) head = { ...head, chunks: { ...head.chunks, doors: { v: version, hash: 'f'.repeat(64) } } };
      hub.head = head;
      hub.bodies = bodies;
      return head;
    },
    async getChunks(names = []) {
      if (hub.down) throw new Error('Hub inalcanzable: ECONNREFUSED');
      const chunks = {};
      for (const n of names) if (hub.bodies[n] !== undefined) chunks[n] = hub.bodies[n];
      return { head: hub.head, chunks };
    },
    async pushEvents(payload) {
      if (hub.down) throw new Error('Hub inalcanzable: ECONNREFUSED');
      if (hub.pushFailures > 0) {
        hub.pushFailures -= 1;
        throw new Error('Hub respondió 503');
      }
      hub.received.push(payload);
      const seqs = payload.events.map((e) => e.seq);
      if (!seqs.length) return { ackSeq: 0 };
      if (hub.ackMode === 'partial') return { ackSeq: seqs[Math.floor(seqs.length / 2)] };
      return { ackSeq: Math.max(...seqs) };
    }
  };
  return hub;
}

/**
 * @param {{dir?:string, interlockMode?:'sensor'|'timed', interlock?:boolean, apply?:boolean, cloud?:object}} [opts]
 */
async function createTestController(opts = {}) {
  const dir = opts.dir || tmpDir('lg-edge-ctl-');
  const cloud = opts.cloud || lanSign.generateKeyPair();
  const hubKeys = opts.hubKeys || lanSign.generateKeyPair();
  const clock = createFakeClock();
  const outputs = {};
  const config = normalizeConfig({
    deviceId: DEVICE,
    dataDir: dir,
    hub: { url: 'http://hub.test:8080', deviceId: 'hub-test', publicKey: hubKeys.publicKeyB64 },
    cloud: { headPublicKeys: { k1: cloud.publicKeyB64 } },
    clock: { trusted: true },
    interlock: { enabled: opts.interlock !== false },
    simulation: { enabled: true },
    doors: ['p1', 'p2', 'p3'].map((id) => ({
      id,
      readers: [{ id: `${id}-in`, driver: 'stdin', side: 'in' }, { id: `${id}-out`, driver: 'stdin', side: 'out' }],
      output: { driver: 'mock', name: id },
      inputs: { driver: 'simulated', dps: true, bond: true, rex: true, emergency: true }
    }))
  }, dir);
  const edge = openEdgeDb(path.join(dir, 'edge.db'), {
    role: 'controller', deviceId: DEVICE, myDoorIds: ['p1', 'p2', 'p3'],
    verifyHead: (h) => lanSign.verifyHead(h, { k1: cloud.publicKeyB64 })
  });
  const hub = opts.hub || createFakeHub(cloud);
  const controller = new Controller({
    config,
    edge,
    hub,
    clock,
    edgeClock: new EdgeClock({ trusted: true, systemNow: () => clock.now() }),
    driverDeps: {
      createOutput: (cfg) => {
        const o = new MockOutput(cfg, { timers: clock });
        outputs[cfg.name] = o;
        return o;
      }
    }
  });
  if (opts.apply !== false && !opts.hub) {
    hub.publish(1, siteBodies({ interlockMode: opts.interlockMode }));
    await controller.configSync.sync('test');
  }
  await controller.start({ hub: false, readers: false });
  clock.advance(60); // debounce del estado inicial de las entradas
  const events = (type) => {
    const rows = edge.db.all('SELECT id FROM events ORDER BY seq').map((r) => edge.journal.get(r.id));
    return type ? rows.filter((e) => e.type === type) : rows;
  };
  const scan = (doorId, who, side = 'in') => controller.handleCredential({
    type: 'dni', value: DNI[who] || who, doorId, readerId: `${doorId}-${side}`, side
  });
  const cleanup = async () => {
    await controller.stop();
    controller.close();
    if (!opts.dir) rmDir(dir);
  };
  return { dir, cloud, hubKeys, clock, outputs, config, edge, hub, controller, events, scan, cleanup };
}

module.exports = { SKIP, DEVICE, DNI, siteBodies, makeHead, createFakeHub, createTestController, tmpDir, rmDir };
