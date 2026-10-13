'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCountingFirestore, FieldValue } = require('./helpers/countingFirestore');
const { createSiteCompiler, COMPILER_VERSION } = require('../lib/siteCompiler/compiler');
const signing = require('../lib/siteCompiler/signing');
const build = require('../lib/siteCompiler/build');
const { decide, createMemorySnapshot, hashCredential, reasonMessage } = require('../lib/accessEngine');
const {
  nationalHolidays,
  explainAccess,
  sanitizeScheduleInput,
  formatDays
} = require('../lib/accessModel');

const signingKey = signing.loadSigningKey({});
const ar = (ymd, hhmm) => Date.parse(`${ymd}T${hhmm}:00.000-03:00`);

test('feriados nacionales: lista fija, trasladables y Carnaval', () => {
  const rows = nationalHolidays(2026);
  const dates = new Set(rows.map((r) => r.date));
  assert.ok(dates.has('2026-01-01'));
  assert.equal(rows.find((r) => r.date === '2026-01-01').name, 'Año Nuevo');
  assert.ok(dates.has('2026-05-25'));
  assert.ok(dates.has('2026-12-25'));
  assert.equal(rows.filter((r) => r.name === 'Carnaval').length, 2);
  const friday = rows.find((r) => r.name === 'Viernes Santo');
  assert.ok(friday);
  const [y, m, d] = friday.date.split('-').map(Number);
  assert.equal(new Date(Date.UTC(y, m - 1, d)).getUTCDay(), 5);
  // 17 de junio de 2026 es miércoles → lunes anterior.
  assert.equal(new Date(Date.UTC(2026, 5, 17)).getUTCDay(), 3);
  assert.ok(dates.has('2026-06-15'));
  assert.equal(dates.has('2026-06-17'), false);
  assert.equal(new Set(rows.map((r) => r.date)).size, rows.length);
  assert.ok(nationalHolidays(2027).every((r) => r.date.startsWith('2027-')));
  assert.deepEqual(formatDays([1, 2, 3, 4, 5]), 'L–V');
});

test('resumen en castellano: grupo, citado y puerta directa', () => {
  const lines = explainAccess({
    accessLevels: ['g1'],
    allowedDoorIds: ['ingreso'],
    groupsById: new Map([['g1', {
      id: 'g1', name: 'Administración', doors: ['ingreso', 'oficinas'], scheduleId: 'sch'
    }]]),
    schedulesById: new Map([['sch', {
      id: 'sch',
      intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
      holidayBehavior: 'deny'
    }]]),
    doorNamesById: new Map([['ingreso', 'Ingreso'], ['oficinas', 'Oficinas']]),
    citedToday: true
  });
  assert.ok(lines.some((l) => l.includes('Grupo Administración') && l.includes('L–V 8 a 18') && l.includes('Ingreso y Oficinas')));
  assert.ok(lines.some((l) => l.includes('Puerta asignada directamente: Ingreso')));
  assert.ok(lines.includes('Citado hoy'));
});

test('horario nocturno y feriado en el motor', () => {
  const office = {
    id: 'sch_ofi',
    intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
    holidayBehavior: 'deny'
  };
  const night = {
    id: 'sch_noche',
    intervals: [{ days: [4], from: '22:00', to: '06:00' }],
    holidayBehavior: 'deny'
  };
  const snap = createMemorySnapshot({
    doors: {
      policy: { tz: 'America/Argentina/Buenos_Aires' },
      doors: [
        { id: 'P1', name: 'Portón', enabled: true, sides: { in: { zoneFrom: 'exterior', zoneTo: 'planta' } } },
        { id: 'P2', name: 'Oficinas', enabled: true, sides: { in: { zoneFrom: 'exterior', zoneTo: 'planta' } } }
      ],
      schedules: [office, night],
      holidays: [{ date: '2026-10-12', name: 'Diversidad cultural' }],
      accessGroups: [
        { id: 'grp_ofi', doors: ['P2'], scheduleId: 'sch_ofi' },
        { id: 'grp_noche', doors: ['P1'], scheduleId: 'sch_noche' }
      ]
    },
    cardholders: {
      cardholders: [
        {
          id: 'ana', status: 'active', name: 'Ana', accessLevels: ['grp_ofi'],
          credentials: [{ type: 'dni', valueHash: hashCredential('dni', '20111222') }]
        },
        {
          id: 'beto', status: 'active', name: 'Beto', accessLevels: ['grp_noche'],
          credentials: [{ type: 'dni', valueHash: hashCredential('dni', '20222333') }]
        }
      ]
    }
  });
  const run = (dni, door, at) => decide({
    snap,
    credential: { type: 'dni', value: dni },
    doorId: door,
    side: 'in',
    at,
    state: { clockTrusted: true, doorStates: { [door]: { state: 'SEGURA', dps: 'closed', bond: 'engaged' } } }
  });
  const nightIn = run('20222333', 'P1', ar('2026-10-08', '22:30'));
  assert.equal(nightIn.decision, 'grant');
  assert.equal(nightIn.reason, 'nivel_acceso');
  assert.equal(run('20222333', 'P1', ar('2026-10-09', '05:30')).decision, 'grant');
  assert.equal(run('20222333', 'P1', ar('2026-10-09', '12:00')).decision, 'deny');
  const holiday = run('20111222', 'P2', ar('2026-10-12', '10:00'));
  assert.equal(holiday.decision, 'deny');
  assert.equal(holiday.reason, 'feriado');
  assert.equal(holiday.message, reasonMessage('feriado'));
  assert.equal(run('20111222', 'P2', ar('2026-10-13', '10:00')).decision, 'grant');
  const bad = sanitizeScheduleInput({ name: 'X', intervals: [{ days: [1], from: '08:00', to: '08:00' }] });
  assert.equal(bad.ok, false);
});

test('compilador: unión de grupos, horario, feriado y derechos anteriores', async () => {
  assert.equal(COMPILER_VERSION, 3);
  const fs = createCountingFirestore({
    'sites/principal': { name: 'Planta', tz: 'America/Argentina/Buenos_Aires' },
    'settings/doorsConfig': {
      doors: [
        { id: 'P1', name: 'Portón', active: true, readers: [{ id: 'INGRESO_P1', direction: 'ingreso' }, { id: 'EGRESO_P1', direction: 'egreso' }] },
        { id: 'P2', name: 'Oficinas', active: true, readers: [{ id: 'INGRESO_P2', direction: 'ingreso' }, { id: 'EGRESO_P2', direction: 'egreso' }] },
        { id: 'P9', name: 'Nueva', active: true, readers: [{ id: 'INGRESO_P9', direction: 'ingreso' }, { id: 'EGRESO_P9', direction: 'egreso' }] }
      ]
    },
    people: {
      ana: { nombre: 'Ana', dniNormalized: '30111001', active: true, allowedDoorIds: ['P1'], accessLevels: ['grp_ofi'] },
      beto: { nombre: 'Beto', dniNormalized: '30111002', active: true, allowedDoorIds: [], accessLevels: ['grp_noche'] },
      carla: { nombre: 'Carla', dniNormalized: '30111003', active: true, allowedDoorIds: [], accessAll: true },
      solo: { nombre: 'Solo', dniNormalized: '30111004', active: true, allowedDoorIds: ['P1'] }
    },
    authorizations: {
      a_ana: { type: 'permanent', personId: 'ana', active: true }
    },
    schedules: {
      sch_ofi: {
        name: 'Oficina',
        intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
        holidayBehavior: 'deny',
        toleranceBeforeMin: 0,
        toleranceAfterMin: 0
      },
      sch_noche: {
        name: 'Noche',
        intervals: [{ days: [4], from: '22:00', to: '06:00' }],
        holidayBehavior: 'deny',
        toleranceBeforeMin: 0,
        toleranceAfterMin: 0
      }
    },
    accessGroups: {
      grp_ofi: { name: 'Administración', doors: ['P2'], scheduleId: 'sch_ofi', memberCount: 1 },
      grp_noche: { name: 'Noche', doors: ['P1'], scheduleId: 'sch_noche', memberCount: 1 }
    },
    holidays: {
      2026: { year: 2026, dates: [{ date: '2026-10-12', name: 'Diversidad cultural' }] }
    }
  });
  const compiler = createSiteCompiler({
    deps: () => ({ db: fs.db, FieldValue }),
    now: () => ar('2026-10-08', '10:00'),
    signingKey,
    autoCompile: false
  });
  const res = await compiler.compileSite('principal', { full: true });
  assert.equal(res.mode, 'full');
  const doors = JSON.parse(fs.peek('sites/principal/compiledChunks/doors').json);
  assert.ok(doors.schedules.some((s) => s.id === 'sch_ofi' && s.catalog === true && s.holidayBehavior === 'deny'));
  assert.ok(doors.schedules.some((s) => s.id === 'sch_noche' && s.intervals[0].from === '22:00'));
  assert.ok(doors.schedules.some((s) => s.id === '24x7' && s.always === true));
  assert.ok(doors.holidays.some((h) => h.date === '2026-10-12'));
  assert.ok(doors.accessGroups.some((g) => g.id === 'grp_total' && g.doors === '*'));
  assert.ok(doors.accessGroups.some((g) => g.id === 'grp_ofi' && g.scheduleId === 'sch_ofi'));

  const ana = JSON.parse(fs.peek(`sites/principal/compiledChunks/${build.chunkNameForPerson('ana')}`).json)
    .cardholders.find((c) => c.id === 'ana');
  assert.deepEqual(ana.accessLevels, ['grp_ofi']);
  assert.ok(ana.doors.some((d) => d.doorId === 'P1' && d.scheduleId === '24x7'), 'la autorización permanente sigue');
  const solo = JSON.parse(fs.peek(`sites/principal/compiledChunks/${build.chunkNameForPerson('solo')}`).json)
    .cardholders.find((c) => c.id === 'solo');
  assert.equal(solo.requiresGrant, true);
  const carla = JSON.parse(fs.peek(`sites/principal/compiledChunks/${build.chunkNameForPerson('carla')}`).json)
    .cardholders.find((c) => c.id === 'carla');
  assert.equal(carla.accessAll, true);

  const snap = await compiler.getCloudSnapshot('principal');
  const run = (dni, door, at) => decide({
    snap,
    credential: { type: 'dni', value: dni },
    doorId: door,
    side: 'in',
    at,
    state: { clockTrusted: true, doorStates: { [door]: { state: 'SEGURA', dps: 'closed', bond: 'engaged' } } }
  });
  assert.equal(run('30111001', 'P1', ar('2026-10-08', '21:00')).reason, 'puerta_directa');
  assert.equal(run('30111001', 'P2', ar('2026-10-08', '10:00')).reason, 'nivel_acceso');
  assert.equal(run('30111001', 'P2', ar('2026-10-08', '21:00')).reason, 'fuera_de_horario');
  assert.equal(run('30111001', 'P2', ar('2026-10-12', '10:00')).reason, 'feriado');
  assert.equal(run('30111001', 'P2', ar('2026-10-13', '10:00')).decision, 'grant');
  assert.equal(run('30111002', 'P1', ar('2026-10-08', '22:30')).decision, 'grant');
  assert.equal(run('30111002', 'P1', ar('2026-10-09', '05:30')).decision, 'grant');
  assert.equal(run('30111002', 'P1', ar('2026-10-09', '12:00')).decision, 'deny');
  assert.equal(run('30111003', 'P9', ar('2026-10-08', '03:00')).reason, 'acceso_total');
  assert.equal(run('30111004', 'P1', ar('2026-10-08', '10:00')).reason, 'sin_citacion_para_hoy');

  fs.poke('accessGroups/grp_nueva', { name: 'Visitas internas', doors: ['P9'], scheduleId: '24x7' });
  fs.poke('holidays/2026', { year: 2026, dates: [] });
  await compiler.markDirty({ doors: true });
  await compiler.compileSite('principal');
  const doors2 = JSON.parse(fs.peek('sites/principal/compiledChunks/doors').json);
  assert.ok(doors2.accessGroups.some((g) => g.id === 'grp_nueva'));
  assert.equal(doors2.holidays.some((h) => h.date === '2026-10-12'), false);
  assert.ok(doors2.schedules.some((s) => s.id === 'sch_ofi'), 'conserva el horario de catálogo');
});
