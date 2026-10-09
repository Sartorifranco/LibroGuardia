'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./_hubkit');

describe('hub: comandos remotos', { skip: k.SKIP }, () => {
  const dirs = [];
  let cloudKeys; let hubKeys; let ctlAKeys; let ctlBKeys;
  let cloud; let ctlA; let ctlB; let built;

  before(async () => {
    cloudKeys = k.generateKeyPair();
    hubKeys = k.generateKeyPair();
    ctlAKeys = k.generateKeyPair();
    ctlBKeys = k.generateKeyPair();
    cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    ctlA = await k.startFakeController({ deviceId: 'ctl-a', hubDeviceId: 'hub-1', hubPublicKey: hubKeys.publicKeyPem });
    ctlB = await k.startFakeController({ deviceId: 'ctl-b', hubDeviceId: 'hub-1', hubPublicKey: hubKeys.publicKeyPem });
    ctlB.openResponse = { ok: false, code: 'AIRLOCK_OTHER_OPEN', relayConfirmed: false };
    const dir = k.tmpDir('lg-hub-cmd-');
    dirs.push(dir);
    built = await k.buildHub({
      dir, cloud, cloudKeys, hubKeys,
      controllers: [
        { deviceId: 'ctl-a', publicKey: ctlAKeys.publicKeyPem, url: ctlA.url },
        { deviceId: 'ctl-b', publicKey: ctlBKeys.publicKeyPem, url: ctlB.url },
        { deviceId: 'ctl-c', publicKey: ctlBKeys.publicKeyPem, url: 'http://127.0.0.1:9', doorIds: ['p7'] }
      ]
    });
    cloud.publish(1, { doors: k.doorsBody() }, cloudKeys);
    await built.hub.headSource.pollNow();
    assert.equal(built.hub.configSync.configVersion(), 1);
  });

  after(async () => {
    await built.hub.stop();
    await cloud.close();
    await ctlA.close();
    await ctlB.close();
    dirs.forEach(k.rmDir);
  });

  it('rutea al controlador dueño de la puerta y reporta el resultado real', async () => {
    const future = Date.now() + 45000;
    cloud.commands = [
      { id: 'c1', doorId: 'p1', action: 'open', requestedBy: 'jefe', reason: 'proveedor', force: false, status: 'pending', expiresAt: future },
      { id: 'c2', doorId: 'p3', action: 'open', requestedBy: 'guardia', reason: 'x', force: true, forceReason: 'evacuación', status: 'pending', expiresAt: new Date(future).toISOString() },
      { id: 'c3', doorId: 'p9', action: 'open', requestedBy: 'g', status: 'pending', expiresAt: future },
      { id: 'c4', doorId: 'p1', action: 'open', requestedBy: 'g', status: 'pending', expiresAt: { _seconds: Math.floor((Date.now() - 1000) / 1000) } },
      { id: 'c5', doorId: 'p1', action: 'lockdown', requestedBy: 'g', status: 'pending', expiresAt: future },
      { id: 'c6', doorId: 'p7', action: 'open', requestedBy: 'g', status: 'pending', expiresAt: future }
    ];
    const r = await built.hub.commands.poll();
    assert.equal(r.processed, 6);
    assert.deepEqual(ctlA.opens, [{ doorId: 'p1', requestedBy: 'jefe', reason: 'proveedor', force: false, mode: 'remote', commandId: 'c1' }]);
    // Comando forzado: la nube ya validó puertas.estanco.forzar + motivo → el hub lo atestigua.
    assert.deepEqual(ctlB.opens, [{
      doorId: 'p3', requestedBy: 'guardia', reason: 'x', force: true, mode: 'remote', commandId: 'c2', forceAuthorized: true, forceReason: 'evacuación'
    }]);
    const byId = Object.fromEntries(cloud.commandResults.map((x) => [x.id, x]));
    assert.equal(byId.c1.status, 'done');
    assert.equal(byId.c1.result.relayConfirmed, true);
    assert.equal(byId.c1.result.controllerId, 'ctl-a');
    assert.equal(byId.c2.status, 'failed');
    assert.equal(byId.c2.result.code, 'AIRLOCK_OTHER_OPEN');
    assert.equal(byId.c3.result.code, 'DOOR_NOT_ROUTED');
    assert.equal(byId.c4.status, 'expired');
    assert.equal(byId.c5.status, 'rejected');
    assert.equal(byId.c6.status, 'failed', 'ruteo por doorIds de la allowlist; controlador caído');
    assert.equal(byId.c6.result.code, 'CONTROLLER_UNREACHABLE');
    // auditoría en el journal del hub
    const audit = built.hub.edge.db.all("SELECT COUNT(*) AS n FROM events WHERE type = 'remote_command'")[0].n;
    assert.equal(audit, 6);
  });

  it('el mismo comando no se ejecuta dos veces', async () => {
    const before = ctlA.opens.length;
    const r = await built.hub.commands.poll();
    assert.equal(r.processed, 0);
    assert.equal(ctlA.opens.length, before);
  });

  it('requestedBy con la forma de la nube ({id, username}) se guarda como texto', async () => {
    cloud.commands = [{ id: 'c0', doorId: 'p2', action: 'open', requestedBy: { id: 'u1', username: 'jefe' }, reason: 'nube', status: 'pending', expiresAt: Date.now() + 45000 }];
    const r = await built.hub.commands.poll();
    assert.equal(r.processed, 1);
    assert.equal(built.hub.edge.db.get("SELECT requested_by FROM commands WHERE id = 'c0'").requested_by, 'jefe');
    assert.deepEqual(ctlA.opens.at(-1).requestedBy, { id: 'u1', username: 'jefe' });
    assert.equal(cloud.commandResults.find((x) => x.id === 'c0').status, 'done');
  });

  it('reporte fallido se reintenta en el próximo poll sin re-ejecutar', async () => {
    cloud.commands = [{ id: 'c7', doorId: 'p2', action: 'open', requestedBy: 'g', status: 'pending', expiresAt: Date.now() + 45000 }];
    // la nube se cae justo después de entregar la lista
    const origResult = built.hub.client.commandResult.bind(built.hub.client);
    built.hub.client.commandResult = async () => { throw Object.assign(new Error('caída'), { code: 'NETWORK' }); };
    await built.hub.commands.poll();
    assert.equal(ctlA.opens.at(-1).doorId, 'p2');
    assert.ok(!cloud.commandResults.some((x) => x.id === 'c7'));
    built.hub.client.commandResult = origResult;
    const opens = ctlA.opens.length;
    await built.hub.commands.poll();
    assert.equal(ctlA.opens.length, opens);
    assert.equal(cloud.commandResults.filter((x) => x.id === 'c7').length, 1);
  });

  it('pista pendingCommands del head: con 0 no consulta; con >0 consulta ya', async () => {
    cloud.commands = [];
    cloud.pendingCommands = 0;
    await built.hub.headSource.pollNow();
    const polls = cloud.commandPolls;
    await built.hub.commands.poll();
    assert.equal(cloud.commandPolls, polls, 'pendingCommands=0 → sin lectura');
    cloud.commands = [{ id: 'c8', doorId: 'p1', action: 'open', requestedBy: 'g', status: 'pending', expiresAt: Date.now() + 45000 }];
    cloud.pendingCommands = 1;
    await built.hub.headSource.pollNow();
    if (built.hub.commands.running) await built.hub.commands.running;
    assert.ok(cloud.commandResults.some((x) => x.id === 'c8' && x.status === 'done'));
  });

  it('sin internet no consulta comandos; endpoint inexistente → pausa', async () => {
    built.hub.commands.setHint(undefined);
    built.hub.commands.hint = undefined;
    cloud.offline = true;
    await built.hub.headSource.pollNow().catch(() => {});
    assert.equal(built.hub.client.online, false);
    const polls = cloud.commandPolls;
    const r = await built.hub.commands.poll();
    assert.equal(r.polled, false);
    cloud.offline = false;
    assert.equal(cloud.commandPolls, polls);

    await built.hub.headSource.pollNow();
    cloud.commandsStatus = 404;
    await built.hub.commands.poll();
    assert.ok(built.hub.commands.disabledUntil > Date.now());
    const p2 = cloud.commandPolls;
    await built.hub.commands.poll();
    assert.equal(cloud.commandPolls, p2);
  });
});
