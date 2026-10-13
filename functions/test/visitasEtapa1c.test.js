'use strict';

/**
 * Visitas etapa 1c: dominio del anfitrión, verificación del mail del autorregistro
 * y duración del QR (un_ingreso / horas / dia / mes).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const build = require('../lib/siteCompiler/build');
const { decide } = require('../lib/accessEngine/decide');
const { createMemorySnapshot } = require('../lib/accessEngine/memorySnapshot');
const { validateSnapshotChunk } = require('../lib/accessEngine');
const { findEligibleVisita } = require('../lib/visitasAccess');
const { createCountingFirestore, FieldValue: CountingFieldValue, Timestamp: CountingTimestamp } = require('./helpers/countingFirestore');
const { createSiteCompiler } = require('../lib/siteCompiler/compiler');
const signing = require('../lib/siteCompiler/signing');
const { ar, TODAY, NOW, buildInitial } = require('./siteCompilerFixture');
const { setupHarness, startRouters, defaultRoleDocs, signTestToken, TEST_JWT_SECRET } = require('./helpers/routeHarness');

const DAY = 86400000;
const base = {
  id: 'v1',
  passCode: 'MSSV1.' + 'B'.repeat(32),
  estado: 'autorizada',
  dniVisitanteNormalized: '30111222',
  fechaHoraEsperada: ar(TODAY, '10:00'),
  allowedDoorIds: ['P1']
};

describe('buildPass: ventana según la duración', () => {
  it('sin duración = un solo ingreso: esperada − 2 h a fin del día, maxUses 1', () => {
    const { pass } = build.buildPass(base, { key: null });
    assert.equal(pass.validFrom, ar(TODAY, '08:00'));
    assert.equal(pass.validTo, ar('2026-10-09', '00:00') - 1);
    assert.equal(pass.maxUses, 1);
    assert.equal(pass.scheduleId, undefined);
  });

  it('un_ingreso con validoHasta del mismo día', () => {
    const { pass } = build.buildPass({ ...base, duracion: 'un_ingreso', validoHasta: ar(TODAY, '12:00') }, { key: null });
    assert.equal(pass.validTo, ar(TODAY, '12:00'));
    assert.equal(pass.maxUses, 1);
  });

  it('horas: esperada − 15 min a validoHasta, sin maxUses', () => {
    const { pass } = build.buildPass({ ...base, duracion: 'horas', validoHasta: ar(TODAY, '14:00') }, { key: null });
    assert.equal(pass.validFrom, ar(TODAY, '09:45'));
    assert.equal(pass.validTo, ar(TODAY, '14:00'));
    assert.equal(pass.maxUses, undefined);
  });

  it('dia: 00:00 a 23:59:59.999 del día, sin maxUses', () => {
    const { pass } = build.buildPass({ ...base, duracion: 'dia' }, { key: null });
    assert.equal(pass.validFrom, ar(TODAY, '00:00'));
    assert.equal(pass.validTo, ar('2026-10-09', '00:00') - 1);
    assert.equal(pass.maxUses, undefined);
  });

  it('mes: del día de inicio al fin del último día, con scheduleId', () => {
    const { pass } = build.buildPass({
      ...base, duracion: 'mes', validoHasta: ar('2026-10-30', '12:00'), scheduleId: 'sch_lv'
    }, { key: null });
    assert.equal(pass.validFrom, ar(TODAY, '00:00'));
    assert.equal(pass.validTo, ar('2026-10-31', '00:00') - 1);
    assert.equal(pass.maxUses, undefined);
    assert.equal(pass.scheduleId, 'sch_lv');
    assert.ok(validateSnapshotChunk('passes', { passes: [pass], revoked: [] }).ok);
  });

  it('el esquema rechaza un scheduleId que no es texto', () => {
    const { pass } = build.buildPass(base, { key: null });
    const v = validateSnapshotChunk('passes', { passes: [{ ...pass, scheduleId: 5 }], revoked: [] });
    assert.equal(v.ok, false);
  });
});

describe('decide: pases según la duración', () => {
  const door = {
    id: 'P1',
    sides: {
      in: { zoneFrom: 'exterior', zoneTo: 'planta' },
      out: { zoneFrom: 'planta', zoneTo: 'exterior' }
    }
  };
  const schedules = [{ id: 'sch_lv', intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }] }];
  const snapWith = (p, policy = {}) => createMemorySnapshot({
    doors: { doors: [door], schedules, policy },
    passes: { passes: [p] }
  });
  const passOf = (extra) => build.buildPass({ ...base, ...extra }, { key: null }).pass;
  const qr = { type: 'qr', value: base.passCode };
  const run = (p, side, at, state = {}, policy = {}) => decide({
    snap: snapWith(p, policy), credential: qr, doorId: 'P1', side, at, state
  });

  it('un_ingreso: el 2.º ingreso se rechaza (aunque haya salido)', () => {
    const p = passOf({});
    assert.equal(run(p, 'in', ar(TODAY, '10:00')).decision, 'grant');
    const r = run({ ...p, uses: 1, status: 'egreso_registrado' }, 'in', ar(TODAY, '11:00'));
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'pase_utilizado');
  });

  it('dia: varias entradas alternando con salidas; dos ingresos seguidos los frena el antipassback', () => {
    const p = passOf({ duracion: 'dia' });
    const policy = { apbMode: 'hard' };
    const first = run(p, 'in', ar(TODAY, '07:00'), { presence: {} }, policy);
    assert.equal(first.decision, 'grant');
    const inside = { ...p, status: 'ingreso_registrado', uses: 1 };
    const out = run(inside, 'out', ar(TODAY, '12:00'), { presence: { [`pass:${p.id}`]: { areaId: 'planta' } } }, policy);
    assert.equal(out.decision, 'grant');
    assert.equal(out.reason, 'egreso_visita');
    const back = run({ ...p, status: 'egreso_registrado', uses: 1 }, 'in', ar(TODAY, '13:00'),
      { presence: { [`pass:${p.id}`]: { areaId: 'exterior' } } }, policy);
    assert.equal(back.decision, 'grant');
    const twice = run(inside, 'in', ar(TODAY, '13:05'), { presence: { [`pass:${p.id}`]: { areaId: 'planta' } } }, policy);
    assert.equal(twice.decision, 'deny');
    assert.equal(twice.reason, 'apb_violacion');
  });

  it('horas: fuera de la franja se rechaza', () => {
    const p = passOf({ duracion: 'horas', validoHasta: ar(TODAY, '12:00') });
    assert.equal(run(p, 'in', ar(TODAY, '09:50')).decision, 'grant');
    assert.equal(run(p, 'in', ar(TODAY, '09:30')).reason, 'visita_antes_de_ventana');
    assert.equal(run(p, 'in', ar(TODAY, '12:30')).reason, 'pase_vencido');
  });

  it('mes con horario: dentro pasa, fuera de horario o fin de semana se rechaza', () => {
    const p = passOf({ duracion: 'mes', validoHasta: ar('2026-10-30', '00:00'), scheduleId: 'sch_lv' });
    assert.equal(run(p, 'in', ar('2026-10-15', '09:00')).decision, 'grant');
    const late = run(p, 'in', ar('2026-10-15', '20:00'));
    assert.equal(late.decision, 'deny');
    assert.equal(late.reason, 'fuera_de_horario');
    assert.equal(run(p, 'in', ar('2026-10-17', '10:00')).reason, 'fuera_de_horario', 'sábado');
    assert.equal(run(p, 'in', ar('2026-11-02', '10:00')).reason, 'pase_vencido');
  });

  it('mes con un horario que no está en el sitio: se rechaza', () => {
    const p = passOf({ duracion: 'mes', validoHasta: ar('2026-10-30', '00:00'), scheduleId: 'sch_borrado' });
    assert.equal(run(p, 'in', ar('2026-10-15', '09:00')).reason, 'fuera_de_horario');
  });
});

describe('nube legacy: ventana por duración', () => {
  const visita = (extra) => ({ ...base, allowedDoorIds: ['molinete-a'], ...extra });
  const find = (v, at, movementType = 'ingreso') => findEligibleVisita({
    passCode: base.passCode, doorId: 'molinete-a', now: new Date(at), movementType, visitasDocs: [v]
  });

  it('dia: puede volver a entrar después de salir', async () => {
    const r = await find(visita({ duracion: 'dia', estado: 'egreso_registrado' }), ar(TODAY, '18:00'));
    assert.equal(r.visita?.id, 'v1');
  });

  it('un_ingreso: después de salir no vuelve a entrar', async () => {
    const r = await find(visita({ estado: 'egreso_registrado' }), ar(TODAY, '11:00'));
    assert.equal(r.visita, null);
  });

  it('horas: fuera de la franja no encuentra la visita', async () => {
    const v = visita({ duracion: 'horas', validoHasta: ar(TODAY, '12:00') });
    assert.equal((await find(v, ar(TODAY, '11:00'))).visita?.id, 'v1');
    assert.equal((await find(v, ar(TODAY, '13:00'))).visita, null);
  });

  it('mes: vale días después del inicio', async () => {
    const v = visita({ duracion: 'mes', validoHasta: ar('2026-10-30', '00:00') });
    assert.equal((await find(v, ar('2026-10-20', '09:00'))).visita?.id, 'v1');
    assert.equal((await find(v, ar('2026-11-01', '09:00'))).visita, null);
  });
});

describe('compilador: visitas de varios días', () => {
  it('incluye una visita por mes que empezó antes de la ventana', async () => {
    const fs = createCountingFirestore(buildInitial());
    fs.poke('visitas/vMes', {
      nombreVisitante: 'Contratista', dniVisitanteNormalized: '40222333', estado: 'autorizada',
      passCode: 'MSSV1.' + 'C'.repeat(32), duracion: 'mes',
      fechaHoraEsperada: CountingTimestamp.fromMillis(NOW - 10 * DAY),
      validoHasta: CountingTimestamp.fromMillis(ar('2026-10-20', '23:59')),
      allowedDoorIds: ['P1']
    });
    const compiler = createSiteCompiler({
      deps: () => ({ db: fs.db, FieldValue: CountingFieldValue }),
      now: () => NOW,
      signingKey: signing.loadSigningKey({}),
      autoCompile: false
    });
    await compiler.compileSite('principal', { full: true });
    const passes = JSON.parse(fs.peek('sites/principal/compiledChunks/passes').json).passes;
    const mes = passes.find((p) => p.visitaId === 'vMes');
    assert.ok(mes, 'la visita por mes sigue en el chunk de pases');
    assert.equal(mes.maxUses, undefined);
    assert.ok(passes.some((p) => p.visitaId === 'v1'), 'las visitas del día siguen');
  });
});

describe('rutas: dominio del anfitrión, verificación del mail y duración', () => {
  let mem;
  let srv;
  const tok = (id, role) => signTestToken({ id, role });
  const host = () => tok('host', 'empleado-visitas');
  const externo = () => tok('ext', 'empleado-visitas');
  const admin = () => tok('adm', 'admin');
  const sup = () => tok('sup', 'supervisor');
  const visitaBody = (extra = {}) => ({
    nombreVisitante: 'Ana Gomez',
    dniVisitante: '28999888',
    destinoId: 'd1',
    fechaHoraEsperada: '2026-10-20T10:00:00-03:00',
    ...extra
  });
  let emailVerification;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    const user = (username, role, extra = {}) => ({
      username, role, active: true, passwordVersion: 1, permissions: [], selfRegistered: false, empresaId: 'emp1', ...extra
    });
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        empresas: { emp1: { nombre: 'Bacarsa', activa: true } },
        destinos: { d1: { nombre: 'Planta', activo: true, doorIds: [] } },
        schedules: { sch_lv: { nombre: 'Lunes a viernes', intervals: [] } },
        users: {
          host: user('ana@bacarsa.com.ar', 'empleado-visitas'),
          ext: user('juan@otra.com', 'empleado-visitas'),
          adm: user('sistemas', 'admin'),
          sup: user('seguridad@bacarsa.com.ar', 'supervisor'),
          unv: user('nueva@bacarsa.com.ar', 'empleado-visitas', {
            email: 'nueva@bacarsa.com.ar', selfRegistered: true, emailVerified: false
          })
        }
      }
    });
    srv = await startRouters(['routes/auth.js', 'routes/empleado.js', 'routes/visitasAdmin.js', 'routes/accessRequests.js']);
    emailVerification = require('../lib/emailVerification');
  });

  after(async () => { await srv.close(); });

  it('mail del dominio permitido: puede invitar', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', { token: host(), body: visitaBody() });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.visita.estado, 'autorizada');
    assert.equal(res.body.visita.duracion, 'un_ingreso');
  });

  it('mail de otro dominio: 403 con mensaje simple (también al pedir por /api/requests)', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', { token: externo(), body: visitaBody() });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Solo el personal con mail @bacarsa.com.ar puede invitar visitas.');
    const req = await srv.request('POST', '/api/requests', { token: externo(), body: { tipo: 'visita', nombre: 'X' } });
    assert.equal(req.status, 403);
  });

  it('el admin queda exento', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', { token: admin(), body: visitaBody() });
    assert.equal(res.status, 201, res.text);
  });

  it('cambiar los dominios en la configuración se aplica al momento', async () => {
    const bad = await srv.request('PUT', '/api/admin/visitas/settings', { token: sup(), body: { dominiosAnfitrion: ['no es dominio'] } });
    assert.equal(bad.status, 400);
    const denied = await srv.request('PUT', '/api/admin/visitas/settings', { token: host(), body: { dominiosAnfitrion: ['otra.com'] } });
    assert.equal(denied.status, 403);
    const put = await srv.request('PUT', '/api/admin/visitas/settings', { token: sup(), body: { dominiosAnfitrion: ['@Otra.com'] } });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(put.body.settings.dominiosAnfitrion, ['otra.com']);
    const get = await srv.request('GET', '/api/admin/visitas/settings', { token: sup() });
    assert.deepEqual(get.body.settings.dominiosAnfitrion, ['otra.com']);

    assert.equal((await srv.request('POST', '/api/empleado/visitas', { token: externo(), body: visitaBody() })).status, 201);
    const hostDenied = await srv.request('POST', '/api/empleado/visitas', { token: host(), body: visitaBody() });
    assert.equal(hostDenied.status, 403);
    assert.match(hostDenied.body.error, /@otra\.com/);

    await srv.request('PUT', '/api/admin/visitas/settings', { token: sup(), body: { dominiosAnfitrion: ['bacarsa.com.ar'] } });
  });

  it('usuario con el mail sin confirmar no puede invitar', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', { token: tok('unv', 'empleado-visitas'), body: visitaBody() });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Confirmá tu mail para poder invitar visitas. Revisá tu correo.');
  });

  it('verificar: token válido confirma el mail; reutilizado falla', async () => {
    const { token, fields } = emailVerification.newVerification();
    mem.setDoc('users', 'v1@bacarsa.com.ar', { username: 'v1@bacarsa.com.ar', email: 'v1@bacarsa.com.ar', role: 'empleado-visitas', ...fields });
    const ok = await srv.request('POST', '/api/public/empleado/verificar', { body: { token } });
    assert.equal(ok.status, 200, ok.text);
    const stored = mem.getDoc('users', 'v1@bacarsa.com.ar');
    assert.equal(stored.emailVerified, true);
    assert.ok(!stored.emailVerifyTokenHash);
    const again = await srv.request('POST', '/api/public/empleado/verificar', { body: { token } });
    assert.equal(again.status, 400);
    const garbage = await srv.request('POST', '/api/public/empleado/verificar', { body: { token: 'x' } });
    assert.equal(garbage.status, 400);
  });

  it('verificar: token vencido (más de 48 h) → 410', async () => {
    const { token, fields } = emailVerification.newVerification(Date.now() - 49 * 3600 * 1000);
    mem.setDoc('users', 'v2@bacarsa.com.ar', { username: 'v2@bacarsa.com.ar', email: 'v2@bacarsa.com.ar', role: 'empleado-visitas', ...fields });
    const res = await srv.request('POST', '/api/public/empleado/verificar', { body: { token } });
    assert.equal(res.status, 410);
    assert.equal(mem.getDoc('users', 'v2@bacarsa.com.ar').emailVerified, false);
  });

  it('reenviar: máximo uno cada 2 minutos; sin SMTP avisa que no se mandó', async () => {
    const { fields } = emailVerification.newVerification();
    mem.setDoc('users', 'v3', { username: 'v3@bacarsa.com.ar', email: 'v3@bacarsa.com.ar', role: 'empleado-visitas', active: true, passwordVersion: 1, ...fields });
    const token = tok('v3', 'empleado-visitas');
    const tooSoon = await srv.request('POST', '/api/auth/resend-verification', { token });
    assert.equal(tooSoon.status, 429);
    mem.setDoc('users', 'v3', { ...mem.getDoc('users', 'v3'), emailVerifySentAtMs: Date.now() - 3 * 60 * 1000 });
    const res = await srv.request('POST', '/api/auth/resend-verification', { token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.sent, false);
    const verified = await srv.request('POST', '/api/auth/resend-verification', { token: host() });
    assert.equal(verified.status, 400);
  });

  it('por horas: exige hora de fin el mismo día y después del inicio', async () => {
    const sinFin = await srv.request('POST', '/api/empleado/visitas', { token: host(), body: visitaBody({ duracion: 'horas' }) });
    assert.equal(sinFin.status, 400);
    const otroDia = await srv.request('POST', '/api/empleado/visitas', {
      token: host(), body: visitaBody({ duracion: 'horas', validoHasta: '2026-10-21T12:00:00-03:00' })
    });
    assert.equal(otroDia.status, 400);
    const antes = await srv.request('POST', '/api/empleado/visitas', {
      token: host(), body: visitaBody({ duracion: 'horas', validoHasta: '2026-10-20T09:00:00-03:00' })
    });
    assert.equal(antes.status, 400);
    const ok = await srv.request('POST', '/api/empleado/visitas', {
      token: host(), body: visitaBody({ duracion: 'horas', validoHasta: '2026-10-20T14:00:00-03:00' })
    });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.visita.estado, 'autorizada');
    assert.equal(ok.body.visita.inviteExpiresAt, new Date('2026-10-20T14:00:00-03:00').toISOString());
  });

  it('duración inválida → 400', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', { token: host(), body: visitaBody({ duracion: 'semana' }) });
    assert.equal(res.status, 400);
  });

  it('por mes: más de 31 días se rechaza en el alta', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', {
      token: host(), body: visitaBody({ duracion: 'mes', validoHasta: '2026-11-25' })
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /31 días/);
  });

  it('por mes: queda pendiente de aprobación aunque el anfitrión tenga visitas.create', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', {
      token: host(), body: visitaBody({ duracion: 'mes', validoHasta: '2026-11-19', scheduleId: 'sch_lv' })
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.visita.estado, 'pendiente_aprobacion');
    assert.equal(res.body.visita.inviteToken, null);
    const doc = mem.getDoc('visitas', res.body.visita.id);
    assert.equal(doc.duracion, 'mes');
    assert.equal(doc.scheduleId, 'sch_lv');
    assert.equal(res.body.visita.inviteExpiresAt, new Date('2026-11-19T23:59:59.999-03:00').toISOString());
  });

  it('por mes: horario inexistente → 400', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas', {
      token: host(), body: visitaBody({ duracion: 'mes', validoHasta: '2026-11-10', scheduleId: 'nope' })
    });
    assert.equal(res.status, 400);
  });

  it('editar a por mes: vuelve a pendiente de aprobación', async () => {
    const created = await srv.request('POST', '/api/empleado/visitas', { token: host(), body: visitaBody() });
    assert.equal(created.body.visita.estado, 'autorizada');
    const res = await srv.request('PATCH', `/api/empleado/visitas/${created.body.visita.id}`, {
      token: host(), body: { fechaHoraEsperada: visitaBody().fechaHoraEsperada, duracion: 'mes', validoHasta: '2026-11-05' }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.visita.estado, 'pendiente_aprobacion');
    const tooLong = await srv.request('PATCH', `/api/empleado/visitas/${created.body.visita.id}`, {
      token: host(), body: { fechaHoraEsperada: visitaBody().fechaHoraEsperada, validoHasta: '2026-12-30' }
    });
    assert.equal(tooLong.status, 400);
  });

  it('editar con un mail de otro dominio: 403', async () => {
    const created = await srv.request('POST', '/api/empleado/visitas', { token: admin(), body: visitaBody() });
    mem.setDoc('visitas', created.body.visita.id, { ...mem.getDoc('visitas', created.body.visita.id), createdByUserId: 'ext' });
    const res = await srv.request('PATCH', `/api/empleado/visitas/${created.body.visita.id}`, { token: externo(), body: { motivo: 'x' } });
    assert.equal(res.status, 403);
  });
});
