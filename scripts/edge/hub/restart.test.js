'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const k = require('./_hubkit');

describe('hub: reinicio conserva el estado (SQLite temporal)', { skip: k.SKIP }, () => {
  const dirs = [];
  after(() => dirs.forEach(k.rmDir));

  it('config, eventos pendientes, lote en vuelo, refresh token rotado, presencia y comandos sobreviven', async () => {
    const cloudKeys = k.generateKeyPair();
    const hubKeys = k.generateKeyPair();
    const ctlKeys = k.generateKeyPair();
    const cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    const ctl = await k.startFakeController({ deviceId: 'ctl-a', hubDeviceId: 'hub-1', hubPublicKey: hubKeys.publicKeyPem });
    const dir = k.tmpDir('lg-hub-restart-');
    dirs.push(dir);
    const controllers = [{ deviceId: 'ctl-a', publicKey: ctlKeys.publicKeyPem, url: ctl.url }];
    try {
      let built = await k.buildHub({ dir, cloud, cloudKeys, hubKeys, controllers });
      const body = k.doorsBody();
      body.doors[0].sides = { in: { zoneTo: 'planta' }, out: { zoneTo: null } };
      cloud.publish(3, { doors: body }, cloudKeys);
      await built.hub.headSource.pollNow();
      built.hub.ingestFromController('ctl-a', { events: k.mkEvents('ctl-a', 1, 250, { decision: 'grant', cardholderId: 'ana' }), configVersionApplied: 3 });
      cloud.eventFail = 1;
      await built.hub.uploader.flush();
      cloud.commands = [{ id: 'c1', doorId: 'p1', action: 'open', requestedBy: 'g', status: 'pending', expiresAt: Date.now() + 45000 }];
      await built.hub.commands.poll();
      const rotated = cloud.refreshToken;
      assert.notEqual(rotated, 'rt-0');
      const served = built.hub.configSync.servedHead();
      await built.hub.stop();

      // la nube ya no acepta el refresh token inicial: el hub debe usar el rotado guardado
      built = await k.buildHub({ dir, cloud, cloudKeys, hubKeys, controllers });
      const hub = built.hub;
      assert.equal(hub.configSync.configVersion(), 3);
      assert.deepEqual(hub.configSync.servedHead(), served);
      assert.equal(hub.edge.journal.stats().pending, 251, '250 de ctl-a + 1 auditoría de comando');
      assert.deepEqual(hub.uploader.inflight(), { from: 1, to: 200 });
      assert.equal(hub.controllers.summary()['ctl-a'].configVersionApplied, 3);
      assert.equal(hub.live.buildSummary().presence.planta.count, 1);

      // re-ingesta del controlador tras el reinicio (no recibió el ack): no duplica
      const r = hub.ingestFromController('ctl-a', { events: k.mkEvents('ctl-a', 1, 250) });
      assert.equal(r.inserted, 0);
      assert.equal(r.ackSeq, 250);

      // mismo comando de nuevo: no se re-ejecuta
      const opens = ctl.opens.length;
      await hub.commands.poll();
      assert.equal(ctl.opens.length, opens);

      await hub.headSource.pollNow();
      assert.equal(cloud.usedRefreshTokens.at(-1), rotated);
      const up = await hub.uploader.flush({ force: true });
      assert.equal(up.pending, 0);
      assert.deepEqual([cloud.eventPosts[1].hubSeqFrom, cloud.eventPosts[1].hubSeqTo], [1, 200], 'el lote en vuelo se reintenta igual');
      await hub.stop();

      // la base del hub no tiene el refresh token en claro
      const raw = fs.readFileSync(built.file);
      assert.ok(!raw.includes(Buffer.from(cloud.refreshToken)));
    } finally {
      await cloud.close();
      await ctl.close();
    }
  });

  it('hub con base corrupta arranca vacío y vuelve a bajar la config completa', async () => {
    const cloudKeys = k.generateKeyPair();
    const hubKeys = k.generateKeyPair();
    const cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    const dir = k.tmpDir('lg-hub-corrupt-');
    dirs.push(dir);
    try {
      fs.writeFileSync(k.path.join(dir, 'hub.db'), Buffer.alloc(8192, 7));
      const built = await k.buildHub({ dir, cloud, cloudKeys, hubKeys, lan: false });
      assert.equal(built.hub.edge.recovered, true);
      cloud.publish(1, { doors: k.doorsBody() }, cloudKeys);
      await built.hub.headSource.pollNow();
      assert.equal(built.hub.configSync.configVersion(), 1);
      await built.hub.stop();
    } finally {
      await cloud.close();
    }
  });
});
