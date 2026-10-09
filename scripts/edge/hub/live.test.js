'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const k = require('./_hubkit');

function doorsWithAreas() {
  const body = k.doorsBody();
  body.areas = [{ id: 'planta' }, { id: 'estanco' }];
  body.doors = [
    { id: 'p1', name: 'Exterior', controllerId: 'ctl-a', sides: { in: { zoneFrom: null, zoneTo: 'estanco' }, out: { zoneFrom: 'estanco', zoneTo: null } } },
    { id: 'p2', name: 'Interior', controllerId: 'ctl-a', sides: { in: { zoneFrom: 'estanco', zoneTo: 'planta' }, out: { zoneFrom: 'planta', zoneTo: 'estanco' } } },
    { id: 'p3', name: 'Portón', controllerId: 'ctl-a', sides: ['in', 'out'] }
  ];
  return body;
}

const people = { cardholders: [{ id: 'ana', status: 'active', name: 'Ana', credentials: [] }, { id: 'beto', status: 'active', name: 'Beto', credentials: [] }] };

describe('hub: resumen vivo', { skip: k.SKIP }, () => {
  const dirs = [];
  let cloudKeys; let hubKeys; let ctlKeys; let cloud; let built;
  let t = Date.now();
  let seq = 0;
  const ev = (fields) => {
    seq += 1;
    t += 1000;
    return { id: `ctl-a:${seq}`, seq, ts: t, ...fields };
  };
  const ingest = (...events) => built.hub.ingestFromController('ctl-a', { events });

  before(async () => {
    cloudKeys = k.generateKeyPair();
    hubKeys = k.generateKeyPair();
    ctlKeys = k.generateKeyPair();
    cloud = await k.startFakeCloud({ hubPublicKey: hubKeys.publicKeyPem, deviceId: 'hub-1' });
    const dir = k.tmpDir('lg-hub-live-');
    dirs.push(dir);
    built = await k.buildHub({
      dir, cloud, cloudKeys, hubKeys, lan: false, now: () => t,
      controllers: [{ deviceId: 'ctl-a', publicKey: ctlKeys.publicKeyPem, url: 'http://127.0.0.1:9' }]
    });
    cloud.publish(1, { doors: doorsWithAreas(), 'ch-00': people }, cloudKeys);
    await built.hub.headSource.pollNow();
    assert.equal(built.hub.configSync.configVersion(), 1);
  });

  after(async () => {
    await built.hub.stop();
    await cloud.close();
    dirs.forEach(k.rmDir);
  });

  it('arma presencia por área, movimientos, estado de puertas y alarmas', () => {
    ingest(
      ev({ type: 'access', decision: 'grant', doorId: 'p1', side: 'in', cardholderId: 'ana' }),
      ev({ type: 'access', decision: 'grant', doorId: 'p2', side: 'in', cardholderId: 'ana' }),
      ev({ type: 'access', decision: 'grant', doorId: 'p1', side: 'in', cardholderId: 'beto' }),
      ev({ type: 'access', decision: 'deny', doorId: 'p1', side: 'in', cardholderId: 'beto', reason: 'fuera_horario_turno' }),
      ev({ type: 'access', decision: 'grant', doorId: 'p3', side: 'in', cardholderId: 'beto' }),
      ev({ type: 'door_state', doorId: 'p1', payload: { state: 'ABIERTA_AUT' } }),
      ev({ type: 'held_open', doorId: 'p2' })
    );
    const s = built.hub.live.buildSummary();
    assert.deepEqual(Object.keys(s.presence).sort(), ['estanco', 'planta']);
    assert.equal(s.presence.planta.count, 1);
    assert.equal(s.presence.planta.people[0].name, 'Ana');
    assert.equal(s.presence.estanco.people[0].id, 'beto', 'puerta sin áreas (p3) no mueve la presencia');
    assert.equal(s.movements.length, 4, 'solo accesos concedidos');
    assert.equal(s.movements[0].cardholderId, 'beto');
    assert.equal(s.doors.find((d) => d.id === 'p1').state, 'ABIERTA_AUT');
    assert.equal(s.doors.find((d) => d.id === 'p3').state, 'DESCONOCIDO');
    assert.deepEqual(s.alarms.map((a) => [a.type, a.doorId, a.state]), [['held_open', 'p2', 'active']]);

    // salida del sitio por p1 lado out → deja de estar presente; puerta segura restaura la alarma
    ingest(
      ev({ type: 'access', decision: 'grant', doorId: 'p1', side: 'out', cardholderId: 'beto' }),
      ev({ type: 'door_state', doorId: 'p2', payload: { state: 'SEGURA' } })
    );
    const s2 = built.hub.live.buildSummary();
    assert.equal(s2.presence.estanco, undefined);
    assert.equal(s2.alarms[0].state, 'restored');
  });

  it('eventos repetidos no alteran el estado (solo se aplican los nuevos)', () => {
    const before = built.hub.live.buildSummary();
    const again = { id: 'ctl-a:1', seq: 1, ts: t - 999999, type: 'access', decision: 'grant', doorId: 'p1', side: 'in', cardholderId: 'beto' };
    const r = built.hub.ingestFromController('ctl-a', { events: [again] });
    assert.equal(r.duplicates, 1);
    assert.deepEqual(built.hub.live.buildSummary(), before);
  });

  it('sube como mucho 1 vez por minuto y solo si cambió', async () => {
    assert.equal(await built.hub.live.maybePost(), 'posted');
    assert.equal(cloud.lives.length, 1);
    assert.equal(cloud.lives[0].presence.planta.count, 1);
    ingest(ev({ type: 'access', decision: 'grant', doorId: 'p1', side: 'in', cardholderId: 'beto' }));
    t += 10 * 1000;
    assert.equal(await built.hub.live.maybePost(), 'throttled');
    t += 60 * 1000;
    assert.equal(await built.hub.live.maybePost(), 'posted');
    t += 61 * 1000;
    assert.equal(await built.hub.live.maybePost(), 'unchanged');
    assert.equal(cloud.lives.length, 2);
    // un error de red no marca como subido
    cloud.offline = true;
    ingest(ev({ type: 'door_forced', doorId: 'p3' }));
    t += 61 * 1000;
    assert.equal(await built.hub.live.maybePost(), 'error');
    cloud.offline = false;
    assert.equal(await built.hub.live.maybePost(), 'posted');
    assert.equal(cloud.lives.at(-1).alarms.some((a) => a.type === 'door_forced'), true);
    if (built.hub.uploader.running) await built.hub.uploader.running;
  });

  it('aplica los stateEffects del controlador: presencia por zoneTo, salida al exterior y cierre del pase', () => {
    const presenceOf = (key) => built.hub.edge.db.get('SELECT area_id FROM presence WHERE cardholder_id = ?', key);
    // Persona: el motor dice planta (aunque la puerta no tenga sides como objeto).
    ingest(ev({
      type: 'access', decision: 'grant', doorId: 'p3', side: 'in', cardholderId: 'ana',
      payload: { stateEffects: { presence: { ana: { areaId: 'planta', ts: t } } } }
    }));
    assert.equal(presenceOf('ana').area_id, 'planta');
    // Salida a un área marcada exterior → deja de estar en el sitio.
    ingest(ev({
      type: 'access', decision: 'grant', doorId: 'p3', side: 'out', cardholderId: 'ana',
      payload: { stateEffects: { presence: { ana: { areaId: 'exterior', ts: t + 1 } } } }
    }));
    assert.equal(presenceOf('ana'), undefined);
    // Visita con pase: ingreso registra presencia 'pass:<id>' y estado del pase.
    ingest(ev({
      type: 'access', decision: 'grant', doorId: 'p1', side: 'in', cardholderId: null,
      payload: { passId: 'QR-1', stateEffects: { presence: { 'pass:QR-1': { areaId: 'estanco', ts: t } }, pass: { id: 'QR-1', status: 'ingreso_registrado', usesDelta: 1 } } }
    }));
    assert.equal(presenceOf('pass:QR-1').area_id, 'estanco');
    assert.deepEqual(
      (({ status, uses }) => ({ status, uses }))(built.hub.live.passState()['QR-1']),
      { status: 'ingreso_registrado', uses: 1 }
    );
    // Egreso hacia el exterior: cierra el pase y borra su presencia.
    ingest(ev({
      type: 'access', decision: 'grant', doorId: 'p1', side: 'out', cardholderId: null,
      payload: { passId: 'QR-1', stateEffects: { presence: { 'pass:QR-1': { areaId: 'exterior', ts: t + 2 } }, pass: { id: 'QR-1', status: 'egreso_registrado' } } }
    }));
    assert.equal(presenceOf('pass:QR-1'), undefined);
    assert.equal(built.hub.live.passState()['QR-1'].status, 'egreso_registrado');
  });
});
