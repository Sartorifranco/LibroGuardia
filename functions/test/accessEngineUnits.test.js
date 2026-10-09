'use strict';

/** Piezas del motor por separado: horarios, interlock, APB, contrato del snapshot. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  localParts,
  isWithinSchedule,
  evaluateSchedule,
  hashCredential,
  normalizeCredentialValue,
  validateSnapshotChunk,
  createMemorySnapshot,
  evaluateApb,
  interlock
} = require('../lib/accessEngine');
const { normalizeDni } = require('../lib/normalize');
const { ar, buildChunks } = require('./accessEngineFixture');

const TZ = 'America/Argentina/Buenos_Aires';

describe('schedule.localParts', () => {
  it('convierte a hora local de Argentina (UTC−3)', () => {
    const p = localParts(Date.UTC(2026, 9, 8, 3, 0, 0), TZ);
    assert.equal(p.ymd, '2026-10-08');
    assert.equal(p.hour, 0);
    assert.equal(p.minuteOfDay, 0);
    assert.equal(p.weekday, 4);
  });
  it('soporta otras zonas', () => {
    const p = localParts(Date.UTC(2026, 0, 15, 12, 30), 'Europe/Madrid');
    assert.equal(p.hour, 13);
    assert.equal(p.minute, 30);
  });
  it('maneja DST genérico (Nueva York, cambio de marzo)', () => {
    assert.equal(localParts(Date.UTC(2026, 2, 8, 6, 59), 'America/New_York').hour, 1);
    assert.equal(localParts(Date.UTC(2026, 2, 8, 7, 0), 'America/New_York').hour, 3);
  });
  it('exige un instante (no usa el reloj del sistema)', () => {
    assert.throws(() => localParts(undefined, TZ), TypeError);
  });
});

describe('schedule.isWithinSchedule', () => {
  const office = { id: 'o', intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }] };
  const night = { id: 'n', intervals: [{ days: [5], from: '22:00', to: '06:00' }], toleranceBeforeMin: 10, toleranceAfterMin: 10 };
  const early = { id: 'e', intervals: [{ days: [4], from: '00:00', to: '02:00' }], toleranceBeforeMin: 30 };

  it('24x7 siempre', () => {
    assert.equal(isWithinSchedule({ id: '24x7' }, ar('2026-10-11', '03:00'), TZ), true);
    assert.equal(isWithinSchedule({ id: 'x', always: true }, ar('2026-10-11', '03:00'), TZ), true);
  });
  it('bordes inclusivos por minuto', () => {
    assert.equal(isWithinSchedule(office, ar('2026-10-08', '08:00'), TZ), true);
    assert.equal(isWithinSchedule(office, ar('2026-10-08', '07:59'), TZ), false);
    assert.equal(isWithinSchedule(office, ar('2026-10-08', '18:00', '59'), TZ), true);
  });
  it('nocturno viernes 22–06 con tolerancias cruzando medianoche', () => {
    assert.equal(isWithinSchedule(night, ar('2026-10-09', '21:50'), TZ), true);
    assert.equal(isWithinSchedule(night, ar('2026-10-09', '21:49'), TZ), false);
    assert.equal(isWithinSchedule(night, ar('2026-10-10', '06:10'), TZ), true);
    assert.equal(isWithinSchedule(night, ar('2026-10-10', '06:11'), TZ), false);
    assert.equal(isWithinSchedule(night, ar('2026-10-08', '23:00'), TZ), false);
  });
  it('tolerancia previa que cae el día anterior', () => {
    assert.equal(isWithinSchedule(early, ar('2026-10-07', '23:30'), TZ), true);
    assert.equal(isWithinSchedule(early, ar('2026-10-07', '23:29'), TZ), false);
  });
  it('fuera_dia vs fuera_horario', () => {
    assert.equal(evaluateSchedule(office, ar('2026-10-10', '10:00'), TZ).reason, 'fuera_dia');
    assert.equal(evaluateSchedule(office, ar('2026-10-08', '20:00'), TZ).reason, 'fuera_horario');
    assert.equal(evaluateSchedule({ id: 'v', intervals: [] }, ar('2026-10-08', '20:00'), TZ).reason, 'sin_intervalos');
  });
  it('feriados: deny / allow / ignore', () => {
    const isHoliday = (ymd, setId) => ymd === '2026-10-12' && setId === 'ar';
    const at = ar('2026-10-12', '10:00');
    assert.equal(evaluateSchedule({ ...office, holidaysSetId: 'ar', holidayBehavior: 'deny' }, at, TZ, { isHoliday }).reason, 'feriado');
    assert.equal(isWithinSchedule({ ...office, holidaysSetId: 'ar', holidayBehavior: 'ignore' }, at, TZ, { isHoliday }), true);
    const sat = { id: 's', intervals: [{ days: [6], from: '08:00', to: '12:00' }], holidaysSetId: 'ar', holidayBehavior: 'allow' };
    assert.equal(isWithinSchedule(sat, ar('2026-10-12', '20:00'), TZ, { isHoliday }), true);
    assert.equal(isWithinSchedule(sat, ar('2026-10-13', '20:00'), TZ, { isHoliday }), false);
  });
  it('tz propia del horario', () => {
    const madrid = { id: 'm', tz: 'Europe/Madrid', intervals: [{ days: [4], from: '13:00', to: '14:00' }] };
    assert.equal(isWithinSchedule(madrid, ar('2026-10-08', '08:30'), TZ), true);
  });
});

describe('snapshotSchema.hashCredential', () => {
  it('DNI usa exactamente normalizeDni (solo dígitos, conserva ceros)', () => {
    for (const raw of ['30.123.456', ' 30123456 ', '0030123456', 'M30-123-456', '']) {
      assert.equal(normalizeCredentialValue('dni', raw), normalizeDni(raw));
    }
    assert.equal(hashCredential('dni', '30.123.456'), hashCredential('dni', '30123456'));
    assert.notEqual(hashCredential('dni', '030123456'), hashCredential('dni', '30123456'));
  });
  it('sha256 hex con prefijo de tipo', () => {
    const h = hashCredential('dni', '30123456');
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, hashCredential('card', '30123456'));
    assert.equal(hashCredential('dni', 'abc'), null);
    assert.throws(() => hashCredential('huella', '1'), TypeError);
  });
});

describe('snapshotSchema.validateSnapshotChunk', () => {
  it('acepta los chunks del sitio de prueba', () => {
    for (const [name, body] of Object.entries(buildChunks())) {
      const r = validateSnapshotChunk(name, body);
      assert.deepEqual(r.errors, [], name);
    }
  });
  it('rechaza valores en claro, hashes inválidos y claves ajenas', () => {
    const r = validateSnapshotChunk('ch-03', {
      cardholders: [{ id: 'a', status: 'active', credentials: [{ type: 'dni', valueHash: 'zz' }] }],
      credentials: [{ type: 'dni', value: '123', valueHash: 'x', cardholderId: 'a', status: 'active' }],
      doors: []
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /en claro/.test(e)));
    assert.ok(r.errors.some((e) => /sha256/.test(e)));
    assert.ok(r.errors.some((e) => /no admitida/.test(e)));
    assert.ok(r.errors.some((e) => /credentials\[0\]: valueHash/.test(e)));
  });
  it('pases: dni normalizado y revoked', () => {
    assert.equal(validateSnapshotChunk('passes', { passes: [{ id: 'q', dni: '30.123.456', doors: [], validFrom: 1, validTo: 2 }] }).ok, false);
    assert.equal(validateSnapshotChunk('passes', { passes: [{ id: 'q', dni: '30123456', doors: [], validFrom: 1, validTo: 2 }], revoked: ['q'] }).ok, true);
  });
  it('valida estanco timed, horarios y grants', () => {
    assert.equal(validateSnapshotChunk('interlockGroups', [{ id: 'g', doorIds: ['a', 'b'], mode: 'timed' }]).ok, false);
    assert.equal(validateSnapshotChunk('schedules', [{ id: 's', intervals: [{ days: [7], from: '8:00', to: '18:00' }] }]).ok, false);
    assert.equal(validateSnapshotChunk('grants-20261008', { grants: [{ id: 'g', cardholderId: 'c', from: 2, to: 1, doors: 'all', source: 'x' }] }).ok, false);
    assert.equal(validateSnapshotChunk('grants-20261008', { date: '2026-10-08', grants: [{ id: 'g', cardholderId: 'c', from: 1, to: 2, doors: '*', source: 'citacion' }] }).ok, true);
    assert.equal(validateSnapshotChunk('accessGroups', [{ id: 'g', entries: [] }]).ok, false);
    assert.equal(validateSnapshotChunk('policy', { tz: TZ, apbMode: 'hard', apbResetMin: 30, repeatWindowSec: 15 }).ok, true);
    assert.equal(validateSnapshotChunk('policy', { apbMode: 'medio' }).ok, false);
    assert.equal(validateSnapshotChunk('policy', { repeatWindowSec: -1 }).ok, false);
    assert.equal(validateSnapshotChunk('otra-cosa', {}).ok, false);
  });
});

describe('memorySnapshot (misma semántica que SqliteSnapshot de T3)', () => {
  const snap = createMemorySnapshot(buildChunks());
  it('rightsFor: directas, grupos y grants; accessAll NO genera filas', () => {
    assert.deepEqual(snap.rightsFor('ch_all', 'D2'), []);
    assert.equal(snap.cardholder('ch_all').accessAll, true);
    assert.deepEqual(snap.rightsFor('ch_ofi', 'D2'), [
      { doorId: 'D2', scheduleId: 'oficina', source: 'group', refId: 'grp_oficina', validFrom: null, validTo: null }
    ]);
    assert.deepEqual(snap.rightsFor('ch_cit', 'D1').map((r) => r.source), ['direct', 'citacion']);
    assert.deepEqual(snap.rightsFor('ch_cit', 'D1')[1].scheduleId, null);
    assert.deepEqual(snap.rightsFor('ch_cit', 'D1')[1].refId, 'auth_1');
    // grant '*' se expande a todas las puertas (el motor lo intersecta si requiresGrant)
    assert.deepEqual(snap.rightsFor('ch_cit', 'D2').map((r) => r.source), ['citacion']);
    assert.equal(snap.rightsFor('ch_grp_total', 'EB')[0].scheduleId, '24x7');
    assert.deepEqual(snap.rightsFor('nadie', 'D1'), []);
  });
  it('findCredential: null | credencial | duplicate', () => {
    assert.equal(snap.findCredential('dni', hashCredential('dni', '1')), null);
    assert.equal(snap.findCredential('dni', hashCredential('dni', '20000001')).cardholderId, 'ch_all');
    const dup = snap.findCredential('dni', hashCredential('dni', '30000001'));
    assert.equal(dup.status, 'duplicate');
    assert.deepEqual(dup.cardholderIds, ['ch_dup1', 'ch_dup2']);
    assert.equal(snap.findCredential('dni', hashCredential('dni', '20000015')).status, 'revoked');
  });
  it('24x7 implícito, feriados, interlock por puerta, pases por QR/DNI, revocaciones', () => {
    assert.equal(snap.schedule('24x7').always, true);
    assert.equal(snap.schedule('nope'), null);
    assert.equal(snap.isHoliday('2026-10-12', 'default'), true);
    assert.equal(snap.isHoliday('2026-10-12', 'otro'), false);
    assert.equal(snap.isHoliday('2026-10-12', null), true);
    assert.equal(snap.isHoliday('2026-10-13'), false);
    assert.equal(snap.interlockGroup('EB').id, 'G1');
    assert.equal(snap.interlockGroup('D1'), null);
    assert.equal(snap.pass('QR-P1').id, 'QR-P1');
    assert.equal(snap.pass('40111222').id, 'QR-P1');
    assert.equal(snap.pass('nada'), null);
    assert.equal(snap.isRevoked('ch:ch_rev'), true);
    assert.equal(snap.isRevoked('p6'), true);
    assert.equal(snap.policy().tz, TZ);
  });
  it('feriados en forma {setId: [fechas]} (default → calendario vacío)', () => {
    const s2 = createMemorySnapshot({ doors: { holidays: { default: ['2026-12-25'], planta: ['2026-12-26'] } } });
    assert.equal(s2.isHoliday('2026-12-25', ''), true);
    assert.equal(s2.isHoliday('2026-12-26', 'planta'), true);
    assert.equal(s2.isHoliday('2026-12-26', null), true);
  });
});

describe('apb', () => {
  const door = { id: 'D', sides: { in: { zoneFrom: 'ext', zoneTo: 'planta' }, out: { zoneFrom: 'planta', zoneTo: 'ext' } } };
  const base = { presenceKey: 'p', door, at: 1_000_000 };
  it('off no evalúa pero actualiza presencia', () => {
    const r = evaluateApb({ ...base, mode: 'off', presence: { p: { areaId: 'planta', ts: 0 } } });
    assert.equal(r.result, 'ok');
    assert.deepEqual(r.effect, { p: { areaId: 'planta', ts: 1_000_000 } });
  });
  it('soft / hard / reset / desconocido / sin presencia', () => {
    const presence = { p: { areaId: 'planta', ts: 990_000 } };
    assert.equal(evaluateApb({ ...base, mode: 'soft', presence }).reason, 'apb_advertencia');
    assert.equal(evaluateApb({ ...base, mode: 'hard', presence }).reason, 'apb_violacion');
    assert.equal(evaluateApb({ ...base, mode: 'hard', presence, side: 'out' }).result, 'ok');
    assert.equal(evaluateApb({ ...base, mode: 'hard', presence: { p: { areaId: 'planta', ts: 0 } }, resetMin: 10 }).result, 'ok');
    assert.equal(evaluateApb({ ...base, mode: 'hard', presence: {} }).result, 'ok');
    assert.equal(evaluateApb({ ...base, mode: 'hard', presence: null }).reason, 'apb_sin_presencia');
  });
  it('puerta sin áreas no aplica APB', () => {
    const r = evaluateApb({ ...base, door: { id: 'X', sides: { in: {} } }, mode: 'hard', presence: { p: { areaId: 'z', ts: 0 } } });
    assert.equal(r.result, 'ok');
    assert.equal(r.effect, null);
  });
});

describe('interlock', () => {
  it('canForce exige permiso y motivo ≥5', () => {
    assert.equal(interlock.canForce({ permissions: [] , forceReason: 'motivo largo' }).reason, 'sin_permiso_forzar');
    assert.equal(interlock.canForce({ permissions: ['puertas.estanco.forzar'], forceReason: 'abcd' }).reason, 'motivo_forzado_requerido');
    assert.equal(interlock.canForce({ permissions: ['puertas.estanco.forzar'], forceReason: 'abcde' }).ok, true);
  });
  it('sensor: sensorsRequired=false solo exige SEGURA y DPS no abierto', () => {
    assert.equal(interlock.isDoorSecure({ state: 'SEGURA' }, false), true);
    assert.equal(interlock.isDoorSecure({ state: 'SEGURA' }, true), false);
    assert.equal(interlock.isDoorSecure({ state: 'FALLA', dps: 'closed', bond: 'engaged' }, true), false);
  });
  it('deriveAirlockPhase exige nowMs', () => {
    assert.throws(() => interlock.deriveAirlockPhase({ phase: 'outer_open', outerOpenedAtMs: 1 }, {}), TypeError);
  });
});

describe('interlock: paridad con doorController (port, no import en el motor)', () => {
  const firestorePath = require.resolve('../firestore');
  const doorControllerPath = require.resolve('../doorController');
  const prev = require.cache[firestorePath];
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: { db: { collection: () => ({ doc: () => ({}) }) }, FieldValue: { serverTimestamp: () => 'TS' }, Timestamp: {} }
  };
  delete require.cache[doorControllerPath];
  const legacy = require('../doorController');
  if (prev) require.cache[firestorePath] = prev; else delete require.cache[firestorePath];
  delete require.cache[doorControllerPath];

  const phases = ['idle', 'outer_open', 'outer_closed_pending', 'inner_allowed', 'inner_open'];
  const roles = ['outer', 'inner', undefined];

  it('evaluateAirlockPhase y evaluateManualAirlockPhase idénticos', () => {
    for (const role of roles) {
      for (const phase of phases) {
        assert.deepEqual(interlock.evaluateAirlockPhase(role, phase), legacy.evaluateAirlockPhase(role, phase), `${role}/${phase}`);
        assert.deepEqual(
          interlock.evaluateManualAirlockPhase(role, phase, 'Puerta X'),
          legacy.evaluateManualAirlockPhase(role, phase, 'Puerta X'),
          `manual ${role}/${phase}`
        );
      }
    }
  });

  it('deriveAirlockPhase idéntico con instantes numéricos', () => {
    const groups = [{}, { outerCloseDelayMs: 1000, interDoorDelayMs: 0, transitTimeoutMs: 5000 }];
    const datas = [
      { phase: 'idle' },
      { phase: 'outer_open', outerOpenedAtMs: 10_000 },
      { phase: 'inner_allowed', outerOpenedAtMs: 10_000 },
      { phase: 'inner_open', innerOpenedAtMs: 10_000 },
      { phase: 'outer_open' }
    ];
    for (const g of groups) {
      for (const d of datas) {
        for (const now of [10_000, 10_999, 11_000, 12_500, 15_000, 16_999, 17_000, 131_999, 132_000, 200_000]) {
          assert.equal(interlock.deriveAirlockPhase(d, g, now), legacy.deriveAirlockPhase(d, g, now), JSON.stringify({ g, d, now }));
          assert.equal(interlock.deriveAirlockPhase(d, { timings: g }, now), legacy.deriveAirlockPhase(d, g, now));
        }
      }
    }
  });
});
