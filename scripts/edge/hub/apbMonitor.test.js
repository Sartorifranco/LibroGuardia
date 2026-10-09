'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSoftApb } = require('./apbMonitor');
const k = require('./_hubkit');

const door = {
  id: 'p1',
  name: 'Exterior',
  sides: {
    in: { zoneFrom: null, zoneTo: 'planta' },
    out: { zoneFrom: 'planta', zoneTo: null }
  }
};
const inner = {
  id: 'p2',
  name: 'Interior',
  sides: {
    in: { zoneFrom: 'estanco', zoneTo: 'planta' },
    out: { zoneFrom: 'planta', zoneTo: 'estanco' }
  }
};
const isExterior = (id) => id === 'exterior';
const grant = (fields) => ({ type: 'access', decision: 'grant', ts: 1_700_000_000_000, ...fields });

describe('apbMonitor: antipassback blando', () => {
  it('egreso sin ingreso avisa y genera alerta posible_colado', () => {
    const r = evaluateSoftApb({
      event: grant({ doorId: 'p1', side: 'out', cardholderId: 'ana' }),
      door, currentAreaId: null, isExterior, personName: 'Ana', doorName: 'Exterior'
    });
    assert.deepEqual(r.warnings, ['egreso_sin_ingreso']);
    assert.equal(r.alert.type, 'posible_colado');
    assert.equal(r.alert.severity, 'media');
    assert.equal(r.alert.name, 'Ana');
    assert.equal(r.alert.doorId, 'p1');
    assert.equal(r.alert.ts, 1_700_000_000_000);
  });

  it('ingreso de quien ya está adentro solo avisa, sin alerta', () => {
    const r = evaluateSoftApb({
      event: grant({ doorId: 'p1', side: 'in', cardholderId: 'ana' }),
      door, currentAreaId: 'planta', isExterior, personName: 'Ana'
    });
    assert.deepEqual(r.warnings, ['ingreso_duplicado']);
    assert.equal(r.alert, null);
  });

  it('el primer ingreso y el tránsito interior no avisan', () => {
    const first = evaluateSoftApb({
      event: grant({ doorId: 'p1', side: 'in', cardholderId: 'ana' }),
      door, currentAreaId: null, isExterior
    });
    assert.deepEqual(first, { warnings: [], alert: null });
    const transit = evaluateSoftApb({
      event: grant({ doorId: 'p2', side: 'in', cardholderId: 'ana' }),
      door: inner, currentAreaId: 'estanco', isExterior
    });
    assert.deepEqual(transit.warnings, []);
    assert.equal(transit.alert, null);
  });

  it('apbMode off no evalúa', () => {
    const r = evaluateSoftApb({
      mode: 'off',
      event: grant({ doorId: 'p1', side: 'out', cardholderId: 'ana' }),
      door, currentAreaId: null, isExterior
    });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.alert, null);
  });
});

function doorsWithAreas() {
  const body = k.doorsBody();
  body.policy = { ...body.policy, apbMode: 'soft' };
  body.areas = [{ id: 'planta' }, { id: 'exterior', exterior: true }];
  body.doors = [
    { id: 'p1', name: 'Exterior', controllerId: 'ctl-a', sides: { in: { zoneFrom: null, zoneTo: 'planta' }, out: { zoneFrom: 'planta', zoneTo: null } } }
  ];
  return body;
}

describe('hub: antipassback blando al ingerir', { skip: k.SKIP }, () => {
  const dirs = [];
  let cloudKeys; let hubKeys; let ctlKeys; let cloud; let built;
  let t = Date.now();
  let seq = 0;
  const ev = (fields) => {
    seq += 1;
    t += 1000;
    return { id: `ctl-a:${seq}`, seq, ts: t, ...fields };
  };

  before(async () => {
    cloudKeys = k.generateKeyPair();
    hubKeys = k.generateKeyPair();
    ctlKeys = k.generateKeyPair();
    cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    const dir = k.tmpDir('lg-hub-apb-');
    dirs.push(dir);
    built = await k.buildHub({
      dir, cloud, cloudKeys, hubKeys, lan: false, now: () => t,
      controllers: [{ deviceId: 'ctl-a', publicKey: ctlKeys.publicKeyPem, url: 'http://127.0.0.1:9' }]
    });
    cloud.publish(1, {
      doors: doorsWithAreas(),
      'ch-00': { cardholders: [{ id: 'ana', status: 'active', name: 'Ana', credentials: [] }] }
    }, cloudKeys);
    await built.hub.headSource.pollNow();
  });

  after(async () => {
    await built.hub.stop();
    await cloud.close();
    dirs.forEach(k.rmDir);
  });

  it('egreso sin ingreso queda en el evento y levanta posible_colado', () => {
    const e = ev({ type: 'access', decision: 'grant', doorId: 'p1', side: 'out', cardholderId: 'ana' });
    built.hub.ingestFromController('ctl-a', { events: [e] });
    const stored = built.hub.edge.journal.get(e.id);
    assert.ok(stored.payload.warnings.includes('egreso_sin_ingreso'));
    const alarm = built.hub.edge.db.get("SELECT type, door_id, state FROM alarms WHERE type = 'posible_colado'");
    assert.equal(alarm.door_id, 'p1');
    assert.equal(alarm.state, 'active');
    const alert = built.hub.edge.db.get("SELECT payload_json FROM events WHERE reason = 'posible_colado'");
    const payload = JSON.parse(alert.payload_json);
    assert.equal(payload.severity, 'media');
    assert.equal(payload.name, 'Ana');
    assert.equal(payload.doorId, 'p1');
    assert.equal(payload.ts, e.ts);
  });

  it('ingreso duplicado solo agrega el warning', () => {
    const enter = ev({ type: 'access', decision: 'grant', doorId: 'p1', side: 'in', cardholderId: 'ana' });
    built.hub.ingestFromController('ctl-a', { events: [enter] });
    const again = ev({ type: 'access', decision: 'grant', doorId: 'p1', side: 'in', cardholderId: 'ana' });
    built.hub.ingestFromController('ctl-a', { events: [again] });
    const stored = built.hub.edge.journal.get(again.id);
    assert.deepEqual(stored.payload.warnings, ['ingreso_duplicado']);
    const n = built.hub.edge.db.get("SELECT count FROM alarms WHERE type = 'posible_colado'");
    assert.equal(n.count, 1, 'el ingreso duplicado no abre otra alerta');
  });
});
