'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./_hubkit');

const ch = (id, name) => ({ cardholders: [{ id, status: 'active', name, credentials: [{ type: 'dni', valueHash: `h_${id}`, status: 'active' }] }] });

describe('hub: sync de configuración', { skip: k.SKIP }, () => {
  const dirs = [];
  let cloudKeys; let hubKeys; let ctlKeys; let otherKeys;
  let cloud; let ctl; let built;

  before(async () => {
    cloudKeys = k.generateKeyPair();
    hubKeys = k.generateKeyPair();
    ctlKeys = k.generateKeyPair();
    otherKeys = k.generateKeyPair();
    cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    ctl = await k.startFakeController({ deviceId: 'ctl-a', hubDeviceId: 'hub-1', hubPublicKey: hubKeys.publicKey });
    const dir = k.tmpDir('lg-hub-');
    dirs.push(dir);
    built = await k.buildHub({
      dir, cloud, cloudKeys, hubKeys,
      controllers: [{ deviceId: 'ctl-a', publicKey: ctlKeys.publicKeyRaw, url: ctl.url }]
    });
  });

  after(async () => {
    await built.hub.stop();
    await cloud.close();
    await ctl.close();
    dirs.forEach(k.rmDir);
  });

  it('primer head: baja todos los chunks, aplica, guarda head firmado y avisa al controlador', async () => {
    cloud.publish(1, { doors: k.doorsBody(), 'ch-00': ch('per_0', 'Ana'), 'ch-01': ch('per_1', 'Beto') }, cloudKeys);
    const head = await built.hub.headSource.pollNow();
    assert.equal(head.version, 1);
    const r = built.hub.configSync.lastResult;
    assert.equal(r.applied, true);
    assert.deepEqual([...r.fetched].sort(), ['ch-00', 'ch-01', 'doors']);
    assert.equal(built.hub.configSync.configVersion(), 1);
    assert.deepEqual(ctl.notifies, [{ version: 1 }]);
    assert.equal(built.hub.edge.snapshot.cardholder('per_1').name, 'Beto');
    // el refresh token se rotó y quedó guardado cifrado (no en claro) en meta
    assert.equal(built.hub.secrets.get('refreshToken'), cloud.refreshToken);
    const rawMeta = built.hub.edge.db.all("SELECT value FROM meta WHERE key LIKE 'secret:%'").map((x) => x.value).join();
    assert.ok(!rawMeta.includes(cloud.refreshToken));
  });

  it('delta: un cambio en un bucket baja SOLO ese chunk', async () => {
    cloud.chunkRequests.length = 0;
    cloud.publish(2, { doors: k.doorsBody(), 'ch-00': ch('per_0', 'Ana'), 'ch-01': ch('per_1', 'Beto Gómez') }, cloudKeys);
    await built.hub.headSource.pollNow();
    assert.deepEqual(cloud.chunkRequests, [['ch-01']]);
    const r = built.hub.configSync.lastResult;
    assert.equal(r.applied, true);
    assert.deepEqual(r.changed, ['ch-01']);
    assert.equal(built.hub.edge.snapshot.cardholder('per_1').name, 'Beto Gómez');
    assert.deepEqual(ctl.notifies.at(-1), { version: 2 });
  });

  it('mismo head otra vez: no baja nada ni re-notifica', async () => {
    cloud.chunkRequests.length = 0;
    const before = ctl.notifies.length;
    await built.hub.headSource.pollNow();
    assert.deepEqual(cloud.chunkRequests, []);
    assert.equal(ctl.notifies.length, before);
  });

  it('head con firma inválida (otra clave o head alterado) se rechaza sin bajar chunks', async () => {
    cloud.chunkRequests.length = 0;
    const bodies = { doors: k.doorsBody(), 'ch-00': ch('per_0', 'Intruso'), 'ch-01': ch('per_1', 'Beto Gómez') };
    cloud.publish(3, bodies, otherKeys);
    await built.hub.headSource.pollNow();
    assert.equal(built.hub.configSync.lastResult.reason, 'bad_signature');
    assert.equal(built.hub.configSync.configVersion(), 2);
    assert.deepEqual(cloud.chunkRequests, []);

    // firmado bien pero alterado después (versión cambiada)
    cloud.publish(3, bodies, cloudKeys);
    cloud.head = { ...cloud.head, version: 99 };
    await built.hub.headSource.pollNow();
    assert.equal(built.hub.configSync.lastResult.reason, 'bad_signature');
    assert.equal(built.hub.configSync.configVersion(), 2);
  });

  it('chunk cuyo cuerpo no coincide con el hash firmado se rechaza (todo-o-nada)', async () => {
    const bodies = { doors: k.doorsBody(), 'ch-00': ch('per_0', 'Ana'), 'ch-01': ch('per_1', 'Carla') };
    cloud.publish(4, bodies, cloudKeys);
    cloud.bodies['ch-01'] = ch('per_1', 'Falsificada');
    await built.hub.headSource.pollNow();
    assert.equal(built.hub.configSync.lastResult.reason, 'hash_mismatch');
    assert.equal(built.hub.configSync.configVersion(), 2);
    assert.equal(built.hub.edge.snapshot.cardholder('per_1').name, 'Beto Gómez');
  });

  it('controladores: head y chunks solo con request firmada de un equipo enrolado', async () => {
    cloud.publish(5, { doors: k.doorsBody(), 'ch-00': ch('per_0', 'Ana'), 'ch-01': ch('per_1', 'Carla'), operators: { operators: [{ username: 'g', hash: 'x' }] } }, cloudKeys);
    await built.hub.headSource.pollNow();
    assert.equal(built.hub.configSync.configVersion(), 5);

    const ok = await k.ctlRequest(built.url, { path: '/edge/config/head', deviceId: 'ctl-a', privateKey: ctlKeys.privateKey });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.version, 5);
    assert.ok(ok.body.sig, 'el head servido conserva la firma de la nube');

    const chunks = await k.ctlRequest(built.url, { path: '/edge/config/chunks?names=ch-01,operators,doors', deviceId: 'ctl-a', privateKey: ctlKeys.privateKey });
    assert.equal(chunks.status, 200);
    assert.deepEqual(Object.keys(chunks.body.chunks).sort(), ['ch-01', 'doors']);
    assert.equal(chunks.body.chunks['ch-01'].hash, cloud.head.chunks['ch-01'].hash);

    const unsigned = await k.ctlRequest(built.url, { path: '/edge/config/head' });
    assert.equal(unsigned.status, 401);
    const stranger = await k.ctlRequest(built.url, { path: '/edge/config/head', deviceId: 'ctl-x', privateKey: otherKeys.privateKey });
    assert.equal(stranger.status, 403);
    const forged = await k.ctlRequest(built.url, { path: '/edge/config/head', deviceId: 'ctl-a', privateKey: otherKeys.privateKey });
    assert.equal(forged.status, 401);
    const old = await k.ctlRequest(built.url, { path: '/edge/config/head', deviceId: 'ctl-a', privateKey: ctlKeys.privateKey, now: Date.now() - 120000 });
    assert.equal(old.status, 401);
    assert.equal(old.body.code, 'LAN_SIG_EXPIRED');
  });

  it('heartbeat informa configVersionApplied de cada controlador y re-notifica a los atrasados', async () => {
    ctl.configVersionApplied = 2;
    const before = ctl.notifies.length;
    const payload = await built.hub.heartbeat();
    assert.equal(payload.configVersionApplied, 5);
    assert.equal(payload.controllers['ctl-a'].configVersionApplied, 2);
    assert.equal(ctl.notifies.length, before + 1);
    assert.equal(cloud.heartbeats.at(-1).controllers['ctl-a'].configVersionApplied, 2);
    ctl.configVersionApplied = 5;
    await built.hub.heartbeat();
    assert.equal(ctl.notifies.length, before + 1, 'al día: no se re-notifica');
  });

  it('/api/runtime responde modo LAN', async () => {
    const res = await fetch(`${built.url}/api/runtime`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: 'lan', capabilities: [], hubId: 'hub-1' });
    const other = await fetch(`${built.url}/api/entries`);
    assert.equal(other.status, 501);
  });
});
