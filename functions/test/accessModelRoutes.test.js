'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');
const { createMemorySnapshot, hashCredential } = require('../lib/accessEngine');

describe('rutas de grupos, horarios y feriados', () => {
  let mem;
  let srv;
  const holder = { snap: null, dirty: [] };

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          admin: { username: 'admin', role: 'admin', active: true, passwordVersion: 1, permissions: [] },
          jefe: { username: 'jefe', role: 'supervisor', active: true, passwordVersion: 1, permissions: [] },
          guardia: { username: 'g', role: 'guardia', active: true, passwordVersion: 1, permissions: [] }
        },
        settings: {
          doorsConfig: {
            doors: [
              { id: 'ingreso', name: 'Ingreso', zone: 'Planta' },
              { id: 'oficinas', name: 'Oficinas', zone: 'Planta' }
            ]
          }
        },
        people: {
          ana: {
            nombre: 'Ana',
            dniNormalized: '30111222',
            active: true,
            allowedDoorIds: ['ingreso'],
            accessLevels: [],
            accessAll: false
          }
        }
      },
      stubs: {
        'lib/siteCompiler': {
          markDirty: (change) => {
            holder.dirty.push(JSON.parse(JSON.stringify(change)));
            return Promise.resolve(true);
          },
          getCloudSnapshot: () => Promise.resolve(holder.snap)
        }
      }
    });
    srv = await startRouters(['routes/accessModel.js']);
    holder.snap = createMemorySnapshot({
      doors: {
        policy: { tz: 'America/Argentina/Buenos_Aires' },
        doors: [{
          id: 'ingreso',
          name: 'Ingreso',
          enabled: true,
          sides: { in: { zoneFrom: 'exterior', zoneTo: 'planta' } }
        }],
        schedules: [{
          id: 'sch_ofi',
          intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
          holidayBehavior: 'deny'
        }],
        holidays: [{ date: '2026-10-12', name: 'Diversidad cultural' }],
        accessGroups: [{ id: 'grp_admin', name: 'Administración', doors: ['ingreso'], scheduleId: 'sch_ofi' }]
      },
      cardholders: {
        cardholders: [{
          id: 'ana',
          status: 'active',
          name: 'Ana',
          accessLevels: ['grp_admin'],
          credentials: [{ type: 'dni', valueHash: hashCredential('dni', '30111222') }]
        }]
      }
    });
  });

  after(async () => { await srv.close(); });

  const token = (id, role) => signTestToken({ id, role });

  it('un guardia no puede crear horarios', async () => {
    const res = await srv.request('POST', '/api/admin/schedules', {
      token: token('guardia', 'guardia'),
      body: { name: 'Oficina', intervals: [{ days: [1], from: '08:00', to: '18:00' }] }
    });
    assert.equal(res.status, 403);
  });

  it('el supervisor crea un horario, no toca Siempre y carga feriados', async () => {
    const created = await srv.request('POST', '/api/admin/schedules', {
      token: token('jefe', 'supervisor'),
      body: {
        name: 'Oficina',
        intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
        holidayBehavior: 'deny'
      }
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.schedule.name, 'Oficina');
    assert.ok(holder.dirty.some((d) => d.doors === true));

    const list = await srv.request('GET', '/api/admin/schedules', { token: token('jefe', 'supervisor') });
    assert.equal(list.status, 200);
    assert.equal(list.body.schedules[0].id, '24x7');
    assert.equal(list.body.schedules[0].builtin, true);

    const locked = await srv.request('DELETE', '/api/admin/schedules/24x7', { token: token('jefe', 'supervisor') });
    assert.equal(locked.status, 400);

    const night = await srv.request('PUT', `/api/admin/schedules/${created.body.schedule.id}`, {
      token: token('jefe', 'supervisor'),
      body: {
        name: 'Noche',
        intervals: [{ days: [4], from: '22:00', to: '06:00' }],
        holidayBehavior: 'deny',
        toleranceBeforeMin: 10,
        toleranceAfterMin: 5
      }
    });
    assert.equal(night.status, 200, night.text);
    assert.equal(night.body.schedule.intervals[0].from, '22:00');

    const national = await srv.request('POST', '/api/admin/holidays/2026/national', {
      token: token('jefe', 'supervisor')
    });
    assert.equal(national.status, 200, national.text);
    assert.ok(national.body.dates.some((d) => d.date === '2026-01-01' && d.name === 'Año Nuevo'));

    const custom = await srv.request('PUT', '/api/admin/holidays/2026', {
      token: token('jefe', 'supervisor'),
      body: { dates: [...national.body.dates, { date: '2026-07-10', name: 'Puente local' }] }
    });
    assert.equal(custom.status, 200, custom.text);
    assert.ok(custom.body.dates.some((d) => d.date === '2026-07-10'));
    assert.ok(custom.body.dates.some((d) => d.date === '2026-01-01'));

    const audits = await mem.db.collection('auditLog').get();
    const actions = audits.docs.map((d) => d.data().action);
    assert.ok(actions.includes('schedule.create'));
    assert.ok(actions.includes('holiday.load_national'));
  });

  it('asigna el grupo a la persona y simula el ingreso', async () => {
    const sch = await srv.request('POST', '/api/admin/schedules', {
      token: token('jefe', 'supervisor'),
      body: {
        name: 'Administración',
        intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
        holidayBehavior: 'deny'
      }
    });
    const group = await srv.request('POST', '/api/admin/access-groups', {
      token: token('jefe', 'supervisor'),
      body: {
        name: 'Administración',
        scheduleId: sch.body.schedule.id,
        doors: ['ingreso', 'oficinas']
      }
    });
    assert.equal(group.status, 201, group.text);
    assert.equal(group.body.group.memberCount, 0);

    const denied = await srv.request('PUT', '/api/admin/people/ana/access', {
      token: token('guardia', 'guardia'),
      body: { accessLevels: [group.body.group.id], accessAll: true }
    });
    assert.equal(denied.status, 403);

    const assigned = await srv.request('PUT', '/api/admin/people/ana/access', {
      token: token('jefe', 'supervisor'),
      body: { accessLevels: [group.body.group.id], accessAll: false }
    });
    assert.equal(assigned.status, 200, assigned.text);
    assert.deepEqual(assigned.body.accessLevels, [group.body.group.id]);
    assert.ok(assigned.body.summary.some((line) => line.startsWith('Grupo Administración')));
    assert.ok(assigned.body.summary.some((line) => line.includes('Puerta asignada directamente')));
    assert.equal(mem.getDoc('people', 'ana').accessLevels[0], group.body.group.id);
    assert.equal(mem.getDoc('accessGroups', group.body.group.id).memberCount, 1);
    assert.ok(holder.dirty.some((d) => Array.isArray(d.people) && d.people.includes('ana')));

    const used = await srv.request('DELETE', `/api/admin/schedules/${sch.body.schedule.id}`, {
      token: token('jefe', 'supervisor')
    });
    assert.equal(used.status, 409);

    const ok = await srv.request('POST', '/api/admin/access/simulate', {
      token: token('jefe', 'supervisor'),
      body: { personId: 'ana', doorId: 'ingreso', at: '2026-10-08T10:00' }
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.decision, 'grant');
    assert.equal(ok.body.headline, 'Sí, puede pasar.');
    assert.match(ok.body.message, /autorizado/i);

    const holiday = await srv.request('POST', '/api/admin/access/simulate', {
      token: token('jefe', 'supervisor'),
      body: { personId: 'ana', doorId: 'ingreso', at: '2026-10-12T10:00' }
    });
    assert.equal(holiday.status, 200, holiday.text);
    assert.equal(holiday.body.decision, 'deny');
    assert.equal(holiday.body.reason, 'feriado');
    assert.match(holiday.body.message, /feriado/i);
  });
});
