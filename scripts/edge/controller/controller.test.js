'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, siteBodies, createTestController, tmpDir, rmDir } = require('./_fixture');
const { FORCE_PERMISSION } = require('../../../functions/lib/accessEngine/interlock');
const { hashCredential } = require('../../../functions/lib/accessEngine');

const pulses = (out) => out.calls.filter((c) => c.op === 'pulse' && !c.failed).map((c) => c.ms);

describe('controlador: decisión local → pulso → journal', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });

  it('grant: pulsa la salida, desbloquea la puerta y registra relayConfirmed', async () => {
    t = await createTestController();
    assert.equal(t.edge.chunks.configVersion(), 1);
    const r = await t.scan('p1', 'ana');
    assert.equal(r.decision, 'grant');
    assert.equal(r.reason, 'nivel_acceso');
    assert.equal(r.relayConfirmed, true);
    assert.deepEqual(pulses(t.outputs.p1), [3000]);
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'DESBLOQUEADA');
    const ev = t.events('access')[0];
    assert.equal(ev.id, r.eventId);
    assert.equal(ev.decision, 'grant');
    assert.equal(ev.cardholderId, 'ana');
    assert.equal(ev.credType, 'dni');
    assert.match(ev.credHash, /^[0-9a-f]{64}$/);
    assert.equal(ev.payload.relayConfirmed, true);
    assert.equal(ev.clockQ, 'config');
    assert.ok(!JSON.stringify(ev).includes('30111222'), 'el DNI no queda en claro en el journal');
  });

  it('deny: desconocida, persona inactiva; sin pulso', async () => {
    t = await createTestController();
    assert.equal((await t.scan('p1', '99888777')).reason, 'credencial_desconocida');
    assert.equal((await t.scan('p1', 'carlos')).reason, 'persona_inactiva');
    assert.deepEqual(pulses(t.outputs.p1), []);
    assert.deepEqual(t.events('access').map((e) => e.decision), ['deny', 'deny']);
    const unknown = t.events('access')[0];
    assert.equal(unknown.payload.idNumberMasked, '*****777');
    assert.ok(!JSON.stringify(unknown).includes('99888777'));
  });

  it('QR multilínea: resuelve por dniHint, archiva credType qr y el DNI enmascarado', async () => {
    t = await createTestController();
    const r = await t.controller.handleCredential({
      type: 'qr',
      value: 'EMPRESA ACME\nNombre\tAna\nDNI\t30111222',
      dniHint: '30111222',
      doorId: 'p1',
      readerId: 'p1-in',
      side: 'in'
    });
    assert.equal(r.decision, 'grant');
    assert.equal(r.reason, 'nivel_acceso');
    const ev = t.events('access').at(-1);
    assert.equal(ev.credType, 'qr');
    assert.equal(ev.cardholderId, 'ana');
    assert.equal(ev.payload.idNumberMasked, '*****222');
    assert.equal(JSON.stringify(ev).includes('30111222'), false);

    const unknown = await t.controller.handleCredential({
      type: 'qr',
      value: 'EMPRESA\nNombre\tNadie\nArea\tCajas',
      doorId: 'p1',
      readerId: 'p1-in',
      side: 'in'
    });
    assert.equal(unknown.reason, 'credencial_desconocida');
    assert.equal(t.events('access').filter((e) => e.reason === 'credencial_desconocida').length, 1);
  });

  it('si el dniHint no está registrado y el QR sí, concede por el QR', async () => {
    t = await createTestController();
    const bodies = siteBodies();
    const ana = bodies['ch-00'].cardholders.find((c) => c.id === 'ana');
    ana.credentials.push({ type: 'qr', valueHash: hashCredential('qr', 'pase-ana'), status: 'active' });
    t.hub.publish(2, bodies);
    const applied = await t.controller.configSync.sync();
    assert.equal(applied.applied, true);
    const r = await t.controller.handleCredential({
      type: 'qr',
      value: 'pase-ana',
      dniHint: '99999999',
      doorId: 'p1',
      readerId: 'p1-in',
      side: 'in'
    });
    assert.equal(r.decision, 'grant');
    const ev = t.events('access').at(-1);
    assert.equal(ev.credType, 'qr');
    assert.equal(ev.cardholderId, 'ana');
    assert.equal(ev.payload.idNumberMasked, '*****999');
    assert.equal(JSON.stringify(ev).includes('99999999'), false);
  });

  it('journalea door_state: DESBLOQUEADA y, tras el pulso, SEGURA', async () => {
    t = await createTestController();
    await t.scan('p1', 'ana');
    assert.equal(t.events('door_state').length, 0, 'la transición espera la ventana de 200 ms');
    t.clock.advance(200);
    const unlocked = t.events('door_state');
    assert.equal(unlocked.length, 1);
    assert.equal(unlocked[0].doorId, 'p1');
    assert.equal(unlocked[0].payload.state, 'DESBLOQUEADA');
    assert.equal(unlocked[0].payload.dps, 'closed');
    assert.equal(unlocked[0].payload.bond, 'engaged');
    assert.equal(typeof unlocked[0].payload.since, 'number');
    t.clock.advance(2800);
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'SEGURA');
    assert.equal(t.events('door_state').length, 1);
    t.clock.advance(200);
    assert.deepEqual(t.events('door_state').map((e) => e.payload.state), ['DESBLOQUEADA', 'SEGURA']);
  });

  it('coalesce: destrabar y abrir la hoja en menos de 200 ms deja un solo door_state', async () => {
    t = await createTestController();
    await t.scan('p1', 'ana');
    t.controller.simInput('p1', 'dps', 'open');
    t.clock.advance(200);
    const evs = t.events('door_state');
    assert.equal(evs.length, 1);
    assert.equal(evs[0].payload.state, 'ABIERTA_AUT');
    assert.equal(evs[0].payload.dps, 'open');
  });

  it('egreso: credencial conocida y activa sin derechos sale; inactiva no', async () => {
    t = await createTestController();
    assert.equal((await t.scan('p1', 'beto', 'in')).reason, 'puerta_no_autorizada');
    t.clock.advance(3100);
    const out = await t.scan('p1', 'beto', 'out');
    assert.equal(out.decision, 'grant');
    assert.equal(out.reason, 'egreso_libre');
    t.clock.advance(3100);
    assert.equal((await t.scan('p1', 'carlos', 'out')).reason, 'persona_inactiva');
  });

  it('el mismo DNI dentro de la ventana queda registrado como lectura repetida', async () => {
    t = await createTestController();
    const first = await t.scan('p1', 'ana');
    const dup = await t.scan('p1', 'ana');
    assert.equal(dup.decision, 'grant');
    assert.equal(dup.reason, 'lectura_repetida');
    assert.equal(t.events('access').length, 2);
    assert.equal(t.events('access')[1].payload.repeatOf, first.eventId);
    t.clock.advance(16000);
    const again = await t.scan('p1', 'ana');
    assert.equal(again.decision, 'grant');
    assert.notEqual(again.reason, 'lectura_repetida');
  });

  it('salida que falla: grant con relayOk=false y sin efectos de estanco', async () => {
    t = await createTestController({ interlockMode: 'timed' });
    t.outputs.p1.failNext = 1;
    const r = await t.scan('p1', 'ana');
    assert.equal(r.decision, 'grant');
    assert.equal(r.relayOk, false);
    assert.deepEqual(t.controller.interlockState, {});
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'SEGURA');
    assert.equal(t.events('access')[0].payload.relayError, 'falla simulada');
  });

  it('needs_approval: queda pendiente y el guardia la aprueba (pulso real)', async () => {
    t = await createTestController();
    const r = await t.scan('p3', 'ana');
    assert.equal(r.decision, 'needs_approval');
    assert.deepEqual(pulses(t.outputs.p3), []);
    const pending = t.controller.listApprovals();
    assert.equal(pending.length, 1);
    assert.equal(t.events('approval_pending')[0].payload.approvalId, r.approvalId);
    const ok = await t.controller.resolveApproval(r.approvalId, { approve: true, requestedBy: { id: 'guardia1' } });
    assert.equal(ok.ok, true);
    assert.deepEqual(pulses(t.outputs.p3), [3000]);
    assert.equal(t.controller.listApprovals().length, 0);
    const res = t.events('approval_resolved')[0];
    assert.equal(res.cardholderId, 'ana');
    assert.equal(res.payload.requestedBy, 'guardia1');
  });
});

describe('controlador: anti-colado (puerta abierta)', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });

  it('cinco personas distintas con la puerta abierta: 5 concedidos, 1 pulso, 0 errores', async () => {
    t = await createTestController();
    const bodies = siteBodies();
    const extra = [
      ['dora', '40111001', 'Dora'],
      ['eva', '40111002', 'Eva'],
      ['fer', '40111003', 'Fer'],
      ['gabi', '40111004', 'Gabi']
    ];
    for (const [id, dni, name] of extra) {
      bodies['ch-00'].cardholders.push({
        id, status: 'active', name, accessLevels: ['grp_total'],
        credentials: [{ type: 'dni', valueHash: hashCredential('dni', dni), status: 'active' }]
      });
    }
    t.hub.publish(2, bodies);
    const applied = await t.controller.configSync.sync();
    assert.equal(applied.applied, true);

    const first = await t.scan('p1', 'ana');
    assert.equal(first.decision, 'grant');
    assert.equal(first.reason, 'nivel_acceso');
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'DESBLOQUEADA');
    assert.equal(pulses(t.outputs.p1).length, 1);

    t.clock.advance(1000);
    const dup = await t.scan('p1', 'ana');
    assert.equal(dup.decision, 'grant');
    assert.equal(dup.reason, 'lectura_repetida');
    assert.equal(t.events('access').length, 2);
    assert.equal(t.events('access')[1].payload.repeatOf, first.eventId);

    const second = await t.scan('p1', '40111001');
    assert.equal(second.decision, 'grant');
    assert.equal(second.reason, 'paso_registrado_puerta_abierta');
    assert.equal(second.message, 'Paso registrado.');
    assert.equal(pulses(t.outputs.p1).length, 1, 'sigue destrabada: se extiende, no hay otro pulso');
    t.clock.advance(2500);
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'DESBLOQUEADA', 'la ventana se extendió');

    t.controller.simInput('p1', 'dps', 'open');
    t.clock.advance(60);
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'ABIERTA_AUT');
    for (const dni of ['40111002', '40111003', '40111004']) {
      const r = await t.scan('p1', dni);
      assert.equal(r.decision, 'grant');
      assert.equal(r.reason, 'paso_registrado_puerta_abierta');
      assert.equal(r.status, undefined);
    }
    assert.equal(pulses(t.outputs.p1).length, 1);
    const granted = t.events('access').filter((e) => e.decision === 'grant');
    assert.equal(granted.length, 6, '5 personas + la lectura repetida de Ana');
    assert.equal(granted.filter((e) => e.reason !== 'lectura_repetida').length, 5);
    assert.equal(t.events('access').filter((e) => e.reason === 'error_interno').length, 0);

    const bad = await t.scan('p1', 'beto');
    assert.equal(bad.decision, 'deny');
    assert.equal(bad.reason, 'puerta_no_autorizada');
    const denied = t.events('access').filter((e) => e.decision === 'deny');
    assert.equal(denied.length, 1);
    assert.ok(denied[0].payload.warnings.includes('intento_con_puerta_abierta'));
  });
});

describe('controlador: aviso con puerta destrabada', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });

  it('quien no está autorizado, con la hoja todavía cerrada, lleva intento_con_puerta_abierta', async () => {
    t = await createTestController();
    assert.equal((await t.scan('p1', 'ana')).reason, 'nivel_acceso');
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'DESBLOQUEADA');
    const stranger = await t.scan('p1', '99888777');
    assert.equal(stranger.decision, 'deny');
    assert.equal(stranger.reason, 'credencial_desconocida');
    const denied = t.events('access').find((e) => e.reason === 'credencial_desconocida');
    assert.ok(denied.payload.warnings.includes('intento_con_puerta_abierta'));
    const known = await t.scan('p1', 'beto');
    assert.equal(known.decision, 'deny');
    assert.equal(known.reason, 'puerta_no_autorizada');
    assert.ok(t.events('access').find((e) => e.reason === 'puerta_no_autorizada').payload.warnings.includes('intento_con_puerta_abierta'));
  });
});

describe('controlador: estanco (interlock)', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });

  it("modo 'sensor': con P1 abierta no se desbloquea P2; manual respeta y forzar exige permiso + motivo", async () => {
    t = await createTestController({ interlockMode: 'sensor' });
    assert.equal((await t.scan('p1', 'ana')).decision, 'grant');
    t.controller.simInput('p1', 'bond', 'released');
    t.controller.simInput('p1', 'dps', 'open');
    t.clock.advance(60);
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'ABIERTA_AUT');

    const blocked = await t.scan('p2', 'ana');
    assert.equal(blocked.decision, 'deny');
    assert.equal(blocked.reason, 'estanco_esperar');
    assert.match(blocked.message, /Esperá a que se cierre la otra puerta/);
    assert.deepEqual(pulses(t.outputs.p2), []);

    const manual = await t.controller.openDoor('p2', { requestedBy: { id: 'g1', permissions: [] }, reason: '' });
    assert.equal(manual.status, 409);
    assert.equal(manual.code, 'AIRLOCK_OTHER_OPEN');
    assert.equal(manual.forcible, true);

    const noPerm = await t.controller.openDoor('p2', { requestedBy: { id: 'g1', permissions: [] }, reason: 'camión atascado', force: true });
    assert.equal(noPerm.status, 403);
    assert.equal(noPerm.reason, 'sin_permiso_forzar');

    const noReason = await t.controller.openDoor('p2', { requestedBy: { id: 'jefe', permissions: [FORCE_PERMISSION] }, reason: 'x', force: true });
    assert.equal(noReason.reason, 'motivo_forzado_requerido');

    const forced = await t.controller.openDoor('p2', { requestedBy: { id: 'jefe', permissions: [FORCE_PERMISSION] }, reason: 'camión atascado', force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.forced, true);
    assert.equal(forced.reason, 'apertura_forzada_estanco');
    assert.deepEqual(pulses(t.outputs.p2), [3000]);
    const ev = t.events('manual_open').at(-1);
    assert.equal(ev.reason, 'apertura_forzada_estanco');
    assert.equal(ev.payload.requestedBy, 'jefe');
    assert.equal(ev.payload.reasonText, 'camión atascado');

    // cooldown de 3 s por puerta
    const again = await t.controller.openDoor('p2', { requestedBy: 'jefe', permissions: [FORCE_PERMISSION], reason: 'otra vez', force: true });
    assert.equal(again.status, 429);
    assert.equal(again.code, 'COOLDOWN');

    // P1 cierra y traba → P2 vuelve a estar disponible
    t.controller.simInput('p1', 'dps', 'closed');
    t.clock.advance(60);
    t.controller.simInput('p1', 'bond', 'engaged');
    t.clock.advance(3100);
    t.controller.simInput('p2', 'dps', 'closed');
    t.clock.advance(60);
    assert.equal((await t.scan('p2', 'ana')).decision, 'grant');
  });

  it("modo 'timed' (banco): exterior → espera → interior; el efecto solo se aplica si salió el pulso", async () => {
    t = await createTestController({ interlockMode: 'timed' });
    const outer = await t.scan('p1', 'ana');
    assert.equal(outer.decision, 'grant');
    assert.equal(t.controller.interlockState.est1.phase, 'outer_open');
    const early = await t.scan('p2', 'ana');
    assert.equal(early.reason, 'estanco_esperar');
    assert.equal(early.decision, 'deny');
    t.clock.advance(7100); // outerCloseDelay 5 s + interDoorDelay 2 s
    const inner = await t.scan('p2', 'ana');
    assert.equal(inner.decision, 'grant');
    assert.equal(t.controller.interlockState.est1.phase, 'inner_open');
  });

  it('interlock apagado en la config local (banco): ignora el grupo', async () => {
    t = await createTestController({ interlockMode: 'sensor', interlock: false });
    t.controller.simInput('p1', 'dps', 'open');
    t.clock.advance(60);
    assert.equal((await t.scan('p2', 'ana')).decision, 'grant');
  });

  it('emergencia en P1: retiene destrabadas P1 y P2 (su estanco), no P3', async () => {
    t = await createTestController();
    t.controller.simInput('p1', 'emergency', true);
    t.clock.advance(60);
    const held = (id) => t.outputs[id].calls.filter((c) => c.op === 'set').map((c) => c.on);
    assert.deepEqual(held('p1'), [true]);
    assert.deepEqual(held('p2'), [true]);
    assert.deepEqual(held('p3'), []);
    assert.ok(t.events('alarm').some((e) => e.reason === 'emergency' && e.payload.state === 'raised'));
    t.controller.simInput('p1', 'emergency', false);
    t.clock.advance(60);
    assert.deepEqual(held('p1'), [true, false]);
    assert.equal(t.controller.doors.get('p2').runner.state.state, 'SEGURA');
  });

  it('puerta forzada y retenida quedan como alarmas en el journal', async () => {
    t = await createTestController();
    t.controller.simInput('p3', 'dps', 'open');
    t.clock.advance(60);
    t.clock.advance(10_000);
    const alarms = t.events('alarm').map((e) => `${e.doorId}:${e.reason}:${e.payload.state}`);
    assert.deepEqual(alarms, ['p3:door_forced:raised']);
    t.controller.simInput('p3', 'dps', 'closed');
    t.clock.advance(60);
    assert.deepEqual(t.events('alarm').map((e) => `${e.reason}:${e.payload.state}`), ['door_forced:raised', 'door_forced:cleared']);
  });
});

describe('controlador: config firmada', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });

  it('rechaza versión vieja, firma inválida y chunk alterado; sigue con la última buena', async () => {
    t = await createTestController();
    const bodies = siteBodies();
    t.hub.publish(0, bodies);
    let r = await t.controller.configSync.sync();
    assert.equal(r.reason, 'stale');

    t.hub.publish(2, bodies, { sign: false });
    r = await t.controller.configSync.sync();
    assert.equal(r.reason, 'bad_signature');

    t.hub.publish(2, bodies, { tamper: true });
    r = await t.controller.configSync.sync();
    assert.equal(r.reason, 'bad_signature');

    // Hub que manda un cuerpo distinto al firmado
    const signed = JSON.parse(JSON.stringify(bodies));
    signed['ch-00'].cardholders.push({ id: 'dora', status: 'active', name: 'Dora', credentials: [] });
    t.hub.publish(3, signed);
    const evil = JSON.parse(JSON.stringify(signed));
    evil['ch-00'].cardholders[1].accessLevels = ['grp_total'];
    t.hub.bodies = evil;
    r = await t.controller.configSync.sync();
    assert.equal(r.reason, 'hash_mismatch');

    assert.equal(t.edge.chunks.configVersion(), 1);
    assert.equal((await t.scan('p1', 'beto')).reason, 'puerta_no_autorizada', 'beto sigue sin derechos');
    assert.deepEqual(t.events('config_rejected').map((e) => e.reason), ['stale', 'bad_signature', 'hash_mismatch']);
  });

  it('versión nueva válida: baja solo los chunks cambiados y aplica', async () => {
    t = await createTestController();
    const bodies = siteBodies();
    bodies['ch-00'].cardholders[1].accessLevels = ['grp_total'];
    t.hub.publish(2, bodies);
    const asked = [];
    const orig = t.hub.getChunks;
    t.hub.getChunks = async (names) => { asked.push(names); return orig(names); };
    const r = await t.controller.configSync.sync();
    assert.equal(r.applied, true);
    assert.deepEqual(asked, [['ch-00']]);
    assert.equal((await t.scan('p1', 'beto')).decision, 'grant');
    assert.equal(t.events('config_applied').at(-1).payload.version, 2);
  });
});

describe('controlador: clave HMAC de credenciales del sitio (chunk secrets)', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });
  const KEY = Buffer.alloc(32, 7).toString('base64');

  it('con el chunk secrets verificado decide con HMAC; la clave no va al journal', async () => {
    t = await createTestController({ apply: false });
    t.hub.publish(1, siteBodies({ credentialKey: KEY }));
    const r = await t.controller.configSync.sync();
    assert.equal(r.applied, true);
    assert.equal(t.controller.configSync.credentialKey(), KEY);
    assert.equal((await t.scan('p1', 'ana')).decision, 'grant');
    assert.ok(!JSON.stringify(t.events()).includes(KEY));
    assert.equal(t.controller.status().config.credentialKey.present, true);
  });

  it('si el hub no entrega secrets: alarma credential_key_missing y NO aplica (todo-o-nada)', async () => {
    t = await createTestController({ apply: false });
    const bodies = siteBodies({ credentialKey: KEY });
    t.hub.publish(1, bodies);
    delete t.hub.bodies.secrets;
    const r = await t.controller.configSync.sync();
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'missing_chunks');
    assert.equal(t.edge.chunks.configVersion(), 0);
    assert.equal(t.controller.configSync.credentialKey(), null);
    assert.ok(t.events('alarm').some((e) => e.reason === 'credential_key_missing'));
    assert.equal((await t.scan('p1', 'ana')).decision, 'deny');
    // el hub lo corrige: al próximo sync baja solo lo que falta y queda operativo
    t.hub.bodies.secrets = siteBodies({ credentialKey: KEY }).secrets;
    const asked = [];
    const orig = t.hub.getChunks.bind(t.hub);
    t.hub.getChunks = (names) => { asked.push(names); return orig(names); };
    await t.controller.configSync.sync();
    assert.ok(asked.length && asked[0].includes('secrets'));
    assert.equal(t.controller.configSync.credentialKey(), KEY);
    t.clock.advance(3100);
    assert.equal((await t.scan('p1', 'ana')).decision, 'grant');
  });

  it('secrets alterado por el hub (hash distinto al firmado) se rechaza', async () => {
    t = await createTestController({ apply: false });
    t.hub.publish(1, siteBodies({ credentialKey: KEY }));
    t.hub.bodies.secrets = { secrets: { credentialKey: Buffer.alloc(32, 9).toString('base64') } };
    const r = await t.controller.configSync.sync();
    assert.equal(r.reason, 'hash_mismatch');
    assert.equal(t.controller.configSync.credentialKey(), null);
  });
});

describe('controlador: eventos al hub, reinicio y cortes', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });

  it('push con reintento (backoff exponencial) y ack por seq', async () => {
    t = await createTestController();
    await t.scan('p1', 'ana');
    await t.scan('p2', '11111111');
    const p = t.controller.pusher;
    t.hub.pushFailures = 2;
    assert.equal((await p.pushOnce()).ok, false);
    assert.equal(p.backoffMs(), 1000);
    assert.equal((await p.pushOnce()).ok, false);
    assert.equal(p.backoffMs(), 2000);
    const before = t.edge.journal.stats().pending;
    assert.ok(before >= 3);
    const ok = await p.pushOnce();
    assert.equal(ok.ok, true);
    assert.equal(t.edge.journal.stats().pending, 0);
    assert.equal(p.failures, 0);
    const sent = t.hub.received[0];
    assert.equal(sent.deviceId, 'ctl-test');
    assert.equal(sent.configVersion, 1);
    assert.ok(sent.status.doors.p1);
    assert.ok(sent.events.every((e) => e.id === `ctl-test:${e.seq}`));
    // heartbeat vacío
    const hb = await p.pushOnce();
    assert.equal(hb.sent, 0);
  });

  it('ack parcial: lo no confirmado se reenvía (idempotente por id)', async () => {
    t = await createTestController();
    for (let i = 0; i < 4; i += 1) {
      await t.scan('p3', `4000000${i}`);
    }
    t.hub.ackMode = 'partial';
    await t.controller.pusher.pushOnce();
    const left = t.edge.journal.pendingBatch().map((e) => e.seq);
    assert.ok(left.length > 0);
    t.hub.ackMode = 'all';
    await t.controller.pusher.pushOnce();
    assert.equal(t.edge.journal.stats().pending, 0);
    const resent = t.hub.received[1].events.map((e) => e.seq);
    assert.deepEqual(resent, left);
  });

  it('reinicio (crash): conserva seq, config y sigue decidiendo', async () => {
    const dir = tmpDir('lg-edge-ctl-restart-');
    try {
      t = await createTestController({ dir });
      await t.scan('p1', 'ana');
      const lastSeq = t.edge.journal.stats().lastSeq;
      const cloud = t.cloud;
      // "kill -9": sin stop ordenado, solo se suelta el archivo
      t.controller.close();
      t = null;
      const { createFakeHub } = require('./_fixture');
      const deadHub = createFakeHub(cloud);
      deadHub.down = true;
      t = await createTestController({ dir, cloud, hub: deadHub, apply: false });
      assert.equal(t.edge.chunks.configVersion(), 1);
      const r = await t.scan('p1', 'ana');
      assert.equal(r.decision, 'grant');
      const ev = t.edge.journal.get(r.eventId);
      assert.ok(ev.seq > lastSeq, `seq ${ev.seq} > ${lastSeq}`);
    } finally {
      if (t) await t.cleanup();
      t = null;
      rmDir(dir);
    }
  });

  it('internet y hub caídos: decide desde SQLite y acumula eventos', async () => {
    t = await createTestController();
    t.hub.down = true;
    const sync = await t.controller.configSync.sync();
    assert.equal(sync.applied, false);
    assert.equal(sync.reason, 'error');
    assert.equal((await t.scan('p1', 'ana')).decision, 'grant');
    t.clock.advance(3100);
    assert.equal((await t.scan('p1', '99999999')).decision, 'deny');
    assert.equal((await t.controller.pusher.pushOnce()).ok, false);
    assert.ok(t.edge.journal.stats().pending >= 3);
    t.hub.down = false;
    assert.equal((await t.controller.pusher.pushOnce()).ok, true);
    assert.equal(t.edge.journal.stats().pending, 0);
  });
});

describe('controlador: lectura repetida de la misma persona', { skip: SKIP }, () => {
  let t;
  afterEach(async () => { if (t) await t.cleanup(); t = null; });

  const publish = async (mutate) => {
    const bodies = siteBodies();
    mutate(bodies);
    t.hub.publish(2, bodies);
    const applied = await t.controller.configSync.sync();
    assert.equal(applied.applied, true);
  };

  const scanCard = () => t.controller.handleCredential({
    type: 'card', value: 'A1B2C3', doorId: 'p1', readerId: 'p1-in', side: 'in'
  });

  it('credencial y DNI en 6 s: 2 eventos, 1 pulso, el segundo es lectura_repetida', async () => {
    t = await createTestController();
    await publish((bodies) => {
      bodies.doors.doors.find((d) => d.id === 'p1').unlockSec = 30;
      const ana = bodies['ch-00'].cardholders.find((c) => c.id === 'ana');
      ana.credentials.push({ type: 'card', valueHash: hashCredential('card', 'A1B2C3'), status: 'active' });
    });
    const card = await scanCard();
    assert.equal(card.decision, 'grant');
    assert.equal(card.reason, 'nivel_acceso');
    t.clock.advance(6000);
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'DESBLOQUEADA');
    const dni = await t.scan('p1', 'ana');
    assert.equal(dni.decision, 'grant');
    assert.equal(dni.reason, 'lectura_repetida');
    const access = t.events('access');
    assert.equal(access.length, 2);
    assert.equal(access[1].payload.repeatOf, card.eventId);
    assert.equal(access[1].cardholderId, 'ana');
    assert.equal(access[1].credType, 'dni');
    assert.equal(access[0].credType, 'card');
    assert.equal(pulses(t.outputs.p1).length, 1);
    assert.equal(access.filter((e) => e.reason !== 'lectura_repetida').length, 1);
  });

  it('si la puerta ya se re-trabó, hay un segundo pulso y sigue siendo un solo paso', async () => {
    t = await createTestController();
    await publish((bodies) => {
      const ana = bodies['ch-00'].cardholders.find((c) => c.id === 'ana');
      ana.credentials.push({ type: 'card', valueHash: hashCredential('card', 'A1B2C3'), status: 'active' });
    });
    const card = await scanCard();
    assert.equal(card.reason, 'nivel_acceso');
    t.clock.advance(4000);
    assert.equal(t.controller.doors.get('p1').runner.state.state, 'SEGURA');
    const dni = await t.scan('p1', 'ana');
    assert.equal(dni.reason, 'lectura_repetida');
    assert.equal(dni.eventId !== card.eventId, true);
    assert.equal(t.events('access')[1].payload.repeatOf, card.eventId);
    assert.deepEqual(pulses(t.outputs.p1), [3000, 3000]);
    assert.equal(t.events('access').filter((e) => e.reason !== 'lectura_repetida').length, 1);
  });

  it('dos personas distintas son dos pasos', async () => {
    t = await createTestController();
    await publish((bodies) => {
      const beto = bodies['ch-00'].cardholders.find((c) => c.id === 'beto');
      beto.accessLevels = ['grp_total'];
    });
    const ana = await t.scan('p1', 'ana');
    t.clock.advance(6000);
    const beto = await t.scan('p1', 'beto');
    assert.equal(ana.reason, 'nivel_acceso');
    assert.notEqual(beto.reason, 'lectura_repetida');
    assert.equal(beto.decision, 'grant');
    assert.equal(t.events('access').filter((e) => e.reason !== 'lectura_repetida').length, 2);
  });

  it('a los 20 s el segundo escaneo es un paso nuevo', async () => {
    t = await createTestController();
    await t.scan('p1', 'ana');
    t.clock.advance(20000);
    const again = await t.scan('p1', 'ana');
    assert.equal(again.decision, 'grant');
    assert.notEqual(again.reason, 'lectura_repetida');
    assert.equal(t.events('access').filter((e) => e.reason !== 'lectura_repetida').length, 2);
  });

  it('la ventana de la puerta manda sobre el default de 15 s', async () => {
    t = await createTestController();
    await publish((bodies) => {
      bodies.doors.doors.find((d) => d.id === 'p1').repeatWindowSec = 5;
    });
    await t.scan('p1', 'ana');
    t.clock.advance(6000);
    const again = await t.scan('p1', 'ana');
    assert.notEqual(again.reason, 'lectura_repetida');
  });

  it('un denegado repetido queda como lectura_repetida y no abre la puerta', async () => {
    t = await createTestController();
    const first = await t.scan('p1', 'beto');
    assert.equal(first.decision, 'deny');
    assert.equal(first.reason, 'puerta_no_autorizada');
    t.clock.advance(6000);
    const second = await t.scan('p1', 'beto');
    assert.equal(second.decision, 'deny');
    assert.equal(second.reason, 'lectura_repetida');
    assert.equal(t.events('access')[1].payload.repeatOf, first.eventId);
    assert.equal(t.events('access')[1].payload.originalReason, 'puerta_no_autorizada');
    assert.deepEqual(pulses(t.outputs.p1), []);
    t.clock.advance(20000);
    const third = await t.scan('p1', 'beto');
    assert.equal(third.reason, 'puerta_no_autorizada');
  });
});
