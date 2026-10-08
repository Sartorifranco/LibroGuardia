'use strict';

/**
 * Integración real por HTTP: nube falsa (de los tests del hub) → hub real (scripts/edge/hub) →
 * controlador real (HubClient + API LAN firmada). Se omite si el hub no está en esta copia.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SKIP, siteBodies, createTestController, tmpDir, rmDir } = require('./_fixture');
const { createLanServer } = require('./lanApi');

const HUB_KIT = path.join(__dirname, '..', 'hub', '_hubkit.js');
const skip = SKIP || (fs.existsSync(HUB_KIT) ? false : 'sin scripts/edge/hub');

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('controlador ⇄ hub real (HTTP firmado)', { skip }, () => {
  let k;
  let cloudKeys;
  let hubKeys;
  let ctlKeys;
  let cloud;
  let built;
  let t;
  let lan;
  const dirs = [];

  before(async () => {
    k = require('../hub/_hubkit');
    cloudKeys = k.generateKeyPair();
    hubKeys = k.generateKeyPair();
    ctlKeys = k.generateKeyPair();
    cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    // Controlador primero (el hub necesita su URL); la URL del hub se completa después.
    t = await createTestController({
      cloud: { publicKeyB64: cloudKeys.publicKeyRaw },
      hubKeys: { publicKeyB64: hubKeys.publicKeyRaw },
      realHub: { url: 'http://127.0.0.1:1', deviceId: 'hub-1', ctlKeys }
    });
    lan = createLanServer({ controller: t.controller, config: t.config });
    await new Promise((r) => lan.listen(0, '127.0.0.1', r));
    const ctlUrl = `http://127.0.0.1:${lan.address().port}`;
    const dir = tmpDir('lg-hub-ctl-');
    dirs.push(dir);
    built = await k.buildHub({
      dir, cloud, cloudKeys, hubKeys,
      controllers: [{ deviceId: 'ctl-test', publicKey: ctlKeys.publicKeyRaw, url: ctlUrl }]
    });
    t.controller.hub.url = built.url;
  });

  after(async () => {
    if (lan) lan.close();
    if (t) await t.cleanup();
    if (built) await built.hub.stop();
    if (cloud) await cloud.close();
    dirs.forEach(rmDir);
  });

  it('config nube → hub → notify → controlador aplica la misma versión firmada', async () => {
    cloud.publish(1, siteBodies(), cloudKeys);
    await built.hub.headSource.pollNow();
    assert.equal(built.hub.configSync.configVersion(), 1);
    assert.ok(await waitFor(() => t.edge.chunks.configVersion() === 1), 'el controlador aplicó v1 tras el notify');
    await t.controller.configSync.running;
    assert.equal(t.controller.edgeClock.sampledAt !== null, true, 'tomó la hora del hub (header Date)');
  });

  it('decide local, empuja eventos al hub y el hub confirma por seq', async () => {
    const r = await t.scan('p1', 'ana');
    assert.equal(r.decision, 'grant');
    const push = await t.controller.pusher.pushOnce();
    assert.equal(push.ok, true, push.error);
    assert.equal(t.edge.journal.stats().pending, 0);
    const row = built.hub.edge.journal.get(r.eventId);
    assert.ok(row, 'el evento está en el hub con el mismo id');
    assert.equal(row.decision, 'grant');
    assert.equal(built.hub.controllers.summary()['ctl-test'].configVersionApplied, 1);
  });

  it('hub → controlador: estado y apertura manual con resultado real', async () => {
    await built.hub.controllers.pollStatus();
    assert.equal(built.hub.controllers.summary()['ctl-test'].online, true);
    const res = await built.hub.controllers.openDoor('ctl-test', 'p3', { requestedBy: 'guardia1', reason: 'proveedor' });
    assert.equal(res.ok, true);
    assert.equal(res.relayConfirmed, true);
    assert.equal(t.edge.journal.get(res.eventId).type, 'manual_open');
    await assert.rejects(
      built.hub.controllers.openDoor('ctl-test', 'p3', { requestedBy: 'guardia1', reason: 'otra vez' }),
      (err) => err.status === 429 && err.code === 'COOLDOWN'
    );
  });
});
