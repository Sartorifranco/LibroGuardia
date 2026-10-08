'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./_hubkit');

describe('hub: eventos de controladores y subida a la nube', { skip: k.SKIP }, () => {
  const dirs = [];
  let cloudKeys; let hubKeys; let ctlKeys; let ctlBKeys;
  let cloud; let built;

  before(() => {
    cloudKeys = k.generateKeyPair();
    hubKeys = k.generateKeyPair();
    ctlKeys = k.generateKeyPair();
    ctlBKeys = k.generateKeyPair();
  });

  beforeEach(async () => {
    cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    const dir = k.tmpDir('lg-hub-ev-');
    dirs.push(dir);
    built = await k.buildHub({
      dir, cloud, cloudKeys, hubKeys,
      controllers: [
        { deviceId: 'ctl-a', publicKey: ctlKeys.publicKeyPem, url: 'http://127.0.0.1:9' },
        { deviceId: 'ctl-b', publicKey: ctlBKeys.publicKeyRaw, url: 'http://127.0.0.1:9' }
      ]
    });
  });

  afterEach(async () => {
    await built.hub.stop();
    await cloud.close();
  });

  after(() => dirs.forEach(k.rmDir));

  const push = (deviceId, keys, events, extra = {}) => k.ctlRequest(built.url, {
    method: 'POST', path: '/edge/events', body: { deviceId, events, ...extra }, deviceId, privateKey: keys.privateKey
  });

  it('ingesta idempotente: reenvío del mismo lote no duplica y responde ackSeq', async () => {
    const r1 = await push('ctl-a', ctlKeys, k.mkEvents('ctl-a', 1, 3));
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ackSeq, 3);
    assert.equal(r1.body.inserted, 3);
    const r2 = await push('ctl-a', ctlKeys, k.mkEvents('ctl-a', 1, 4));
    assert.equal(r2.body.ackSeq, 4);
    assert.equal(r2.body.inserted, 1);
    assert.equal(r2.body.duplicates, 3);
    const r3 = await push('ctl-b', ctlBKeys, k.mkEvents('ctl-b', 1, 2), { configVersionApplied: 7 });
    assert.equal(r3.body.ackSeq, 2);
    const st = built.hub.edge.journal.stats();
    assert.equal(st.total, 6);
    assert.equal(st.lastHubSeq, 6, 'hub_seq solo avanza con eventos nuevos');
    assert.equal(built.hub.controllers.summary()['ctl-b'].configVersionApplied, 7);
  });

  it('rechaza firma inválida, replay, equipo ajeno y eventos de otro equipo', async () => {
    const forged = await k.ctlRequest(built.url, {
      method: 'POST', path: '/edge/events', body: { deviceId: 'ctl-a', events: k.mkEvents('ctl-a', 1, 1) }, deviceId: 'ctl-a', privateKey: ctlBKeys.privateKey
    });
    assert.equal(forged.status, 401);

    const body = { deviceId: 'ctl-a', events: k.mkEvents('ctl-a', 1, 1) };
    const first = await k.ctlRequest(built.url, { method: 'POST', path: '/edge/events', body, deviceId: 'ctl-a', privateKey: ctlKeys.privateKey });
    assert.equal(first.status, 200);
    const replay = await k.ctlRequest(built.url, { method: 'POST', path: '/edge/events', body, headers: first.headers });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'LAN_SIG_REPLAY');

    // ctl-b firma bien pero manda eventos de ctl-a
    const spoof = await push('ctl-b', ctlBKeys, k.mkEvents('ctl-a', 9, 1));
    assert.equal(spoof.status, 400);
    const mismatch = await k.ctlRequest(built.url, {
      method: 'POST', path: '/edge/events', body: { deviceId: 'ctl-a', events: [] }, deviceId: 'ctl-b', privateKey: ctlBKeys.privateKey
    });
    assert.equal(mismatch.status, 403);
    assert.equal(built.hub.edge.journal.stats().total, 1);
  });

  it('subida en lotes ≤200 por hub_seq contiguo y ack de cada lote', async () => {
    built.hub.ingestFromController('ctl-a', { events: k.mkEvents('ctl-a', 1, 300) });
    built.hub.ingestFromController('ctl-b', { events: k.mkEvents('ctl-b', 1, 150) });
    const r = await built.hub.uploader.flush();
    assert.equal(r.uploaded, 450);
    assert.equal(r.batches, 3);
    assert.equal(r.pending, 0);
    const sizes = cloud.eventPosts.map((p) => p.events.length);
    assert.deepEqual(sizes, [200, 200, 50]);
    let expectedFrom = 1;
    for (const p of cloud.eventPosts) {
      assert.equal(p.hubId, 'hub-1');
      assert.equal(p.hubSeqFrom, expectedFrom);
      assert.equal(p.hubSeqTo, expectedFrom + p.events.length - 1);
      assert.deepEqual(p.events.map((e) => e.hubSeq), Array.from({ length: p.events.length }, (_, i) => expectedFrom + i));
      expectedFrom = p.hubSeqTo + 1;
    }
    assert.equal(cloud.eventPosts[0].events[0].id, 'ctl-a:1');
    // nada más para subir
    const again = await built.hub.uploader.flush({ force: true });
    assert.equal(again.batches, 0);
    assert.equal(cloud.eventPosts.length, 3);
  });

  it('ack parcial de la nube: se confirma solo hasta ackHubSeq y el resto se reintenta', async () => {
    built.hub.ingestFromController('ctl-a', { events: k.mkEvents('ctl-a', 1, 10) });
    let calls = 0;
    cloud.ackMode = (b) => { calls += 1; return calls === 1 ? b.hubSeqFrom + 3 : b.hubSeqTo; };
    const r = await built.hub.uploader.flush();
    assert.equal(r.pending, 0);
    assert.deepEqual(cloud.eventPosts.map((p) => [p.hubSeqFrom, p.hubSeqTo]), [[1, 10], [5, 10]]);
  });

  it('sin internet acumula (semanas); al volver drena todo con el mismo rango en vuelo', async () => {
    built.hub.ingestFromController('ctl-a', { events: k.mkEvents('ctl-a', 1, 120) });
    // la nube recibe el lote pero responde 500 (respuesta perdida) → reintento idéntico
    cloud.eventFail = 1;
    const r1 = await built.hub.uploader.flush();
    assert.equal(r1.error, 'INTERNAL');
    assert.equal(r1.pending, 120);
    assert.ok(built.hub.uploader.nextAttemptAt > Date.now(), 'backoff activo');
    const skipped = await built.hub.uploader.flush();
    assert.equal(skipped.skipped, 'backoff');

    cloud.offline = true;
    const r2 = await built.hub.uploader.flush({ force: true });
    assert.equal(r2.error, 'NETWORK');
    assert.equal(built.hub.client.online, false);
    assert.ok(built.hub.uploader.failures >= 2);
    // siguen llegando eventos mientras no hay internet
    for (let i = 0; i < 5; i += 1) built.hub.ingestFromController('ctl-a', { events: k.mkEvents('ctl-a', 121 + i * 100, 100) });
    assert.equal(built.hub.edge.journal.stats().pending, 620);

    cloud.offline = false;
    const r3 = await built.hub.uploader.flush({ force: true });
    assert.equal(r3.pending, 0);
    assert.equal(r3.uploaded, 620);
    const posts = cloud.eventPosts;
    assert.deepEqual([posts[0].hubSeqFrom, posts[0].hubSeqTo], [1, 120]);
    assert.deepEqual([posts[1].hubSeqFrom, posts[1].hubSeqTo], [1, 120], 'reintento con el mismo rango (idempotente en la nube)');
    assert.ok(posts.every((p) => p.events.length <= 200));
    assert.equal(built.hub.uploader.failures, 0);
  });

  it('una alarma dispara la subida inmediata', async () => {
    const r = await push('ctl-a', ctlKeys, [{ id: 'ctl-a:1', seq: 1, ts: Date.now(), doorId: 'p1', type: 'door_forced' }]);
    assert.equal(r.status, 200);
    for (let i = 0; i < 40 && cloud.eventPosts.length === 0; i += 1) await new Promise((res) => setTimeout(res, 50));
    assert.equal(cloud.eventPosts.length, 1);
    assert.equal(cloud.eventPosts[0].events[0].type, 'door_forced');
    if (built.hub.uploader.running) await built.hub.uploader.running;
  });
});
