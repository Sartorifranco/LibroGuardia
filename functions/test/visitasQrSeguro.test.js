'use strict';

/**
 * Visitas etapa 1a: código de pase opaco (MSSV1.), uso único en el borde,
 * vencimiento del link público y cancelar/editar por el anfitrión.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  generatePassCode,
  parsePassCode,
  isValidPassCode,
  looksLikePassCode
} = require('../lib/visitPassCode');
const build = require('../lib/siteCompiler/build');
const { decide } = require('../lib/accessEngine/decide');
const { createMemorySnapshot } = require('../lib/accessEngine/memorySnapshot');
const { findEligibleVisita } = require('../lib/visitasAccess');
const { detectAuthMethod } = require('../lib/accessAuthMethods');
const { setupHarness, startRouters, defaultRoleDocs, signTestToken, TEST_JWT_SECRET } = require('./helpers/routeHarness');

const NOW = Date.parse('2026-07-22T17:00:00.000Z'); // 14:00 AR

describe('visitPassCode', () => {
  it('genera MSSV1. + 32 hex en mayúscula, distinto cada vez', () => {
    const a = generatePassCode();
    const b = generatePassCode();
    assert.match(a, /^MSSV1\.[0-9A-F]{32}$/);
    assert.notEqual(a, b);
    assert.equal(isValidPassCode(a), true);
  });

  it('parsea a forma canónica y rechaza formatos inválidos', () => {
    const code = generatePassCode();
    assert.equal(parsePassCode(`  ${code.toLowerCase()} `), code);
    assert.equal(parsePassCode('MSSV1.123'), null);
    assert.equal(parsePassCode('30111222'), null);
    assert.equal(parsePassCode(null), null);
    assert.equal(isValidPassCode('MSSV2.' + 'A'.repeat(32)), false);
  });

  it('looksLikePassCode detecta el prefijo aunque el resto esté mal', () => {
    assert.equal(looksLikePassCode('mssv1.xyz'), true);
    assert.equal(looksLikePassCode('30111222'), false);
  });
});

describe('buildPass con passCode', () => {
  const base = {
    id: 'v1',
    qrId: 'v1',
    estado: 'autorizada',
    dniVisitanteNormalized: '30111222',
    fechaHoraEsperada: NOW,
    allowedDoorIds: ['P1']
  };

  it('usa passCode como id del pase y carga maxUses = 1', () => {
    const passCode = generatePassCode();
    const { pass, revoked } = build.buildPass({ ...base, passCode }, { key: null });
    assert.equal(pass.id, passCode);
    assert.equal(pass.visitaId, 'v1');
    assert.equal(pass.maxUses, 1);
    assert.equal(revoked, null);
  });

  it('sin passCode mantiene qrId / id', () => {
    assert.equal(build.buildPass(base, { key: null }).pass.id, 'v1');
    assert.equal(build.buildPass({ ...base, qrId: undefined }, { key: null }).pass.id, 'v1');
  });

  it('cancelada revoca el código y los códigos anteriores quedan revocados', () => {
    const passCode = generatePassCode();
    const old = generatePassCode();
    const cancelled = build.buildPass({ ...base, passCode, estado: 'cancelada' }, { key: null });
    assert.equal(cancelled.pass, null);
    assert.equal(cancelled.revoked, `pass:${passCode}`);
    const edited = build.buildPass({ ...base, passCode, previousPassCodes: [old] }, { key: null });
    assert.equal(edited.pass.id, passCode);
    assert.deepEqual(edited.revokedPrevious, [`pass:${old}`]);
  });
});

describe('decide: pase de visita de un solo ingreso', () => {
  const passCode = generatePassCode();
  const { pass } = build.buildPass({
    id: 'v1',
    estado: 'autorizada',
    passCode,
    dniVisitanteNormalized: '30111222',
    fechaHoraEsperada: NOW,
    allowedDoorIds: ['P1']
  }, { key: null });
  const snapWith = (p) => createMemorySnapshot({
    doors: { doors: [{ id: 'P1', sides: ['in', 'out'] }] },
    passes: { passes: [p] }
  });
  const qr = { type: 'qr', value: passCode };

  it('primer ingreso con el QR: permitido y suma un uso', () => {
    const r = decide({ snap: snapWith(pass), credential: qr, doorId: 'P1', side: 'in', at: NOW });
    assert.equal(r.decision, 'grant');
    assert.equal(r.reason, 'pase_visita');
  });

  it('segundo ingreso (uses = 1): rechazado con pase_utilizado', () => {
    const used = { ...pass, uses: 1 };
    const r = decide({ snap: snapWith(used), credential: qr, doorId: 'P1', side: 'in', at: NOW });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'pase_utilizado');
  });

  it('egreso con el pase usado sigue permitido', () => {
    const inside = { ...pass, uses: 1, status: 'ingreso_registrado' };
    const r = decide({ snap: snapWith(inside), credential: qr, doorId: 'P1', side: 'out', at: NOW + 3600000 });
    assert.equal(r.decision, 'grant');
    assert.equal(r.reason, 'egreso_visita');
  });
});

describe('nube legacy: visita por passCode', () => {
  const passCode = generatePassCode();
  const visita = {
    id: 'v1',
    passCode,
    dniVisitanteNormalized: '30111222',
    fechaHoraEsperada: '2026-07-22T17:00:00.000Z',
    allowedDoorIds: ['molinete-a'],
    estado: 'autorizada'
  };
  const now = new Date('2026-07-22T16:30:00.000Z');

  it('encuentra la visita por el código del QR', async () => {
    const r = await findEligibleVisita({ passCode, doorId: 'molinete-a', now, visitasDocs: [visita] });
    assert.equal(r.visita?.id, 'v1');
  });

  it('un código MSSV1. en el campo DNI no se trata como DNI', async () => {
    const r = await findEligibleVisita({ dniNormalized: passCode, doorId: 'molinete-a', now, visitasDocs: [visita] });
    assert.equal(r.visita?.id, 'v1');
    const bad = await findEligibleVisita({
      dniNormalized: 'MSSV1.30111222',
      doorId: 'molinete-a',
      now,
      visitasDocs: [visita]
    });
    assert.equal(bad.visita, null);
    assert.equal(bad.reason, 'pase_invalido');
  });

  it('el DNI sigue sirviendo', async () => {
    const r = await findEligibleVisita({ dniNormalized: '30111222', doorId: 'molinete-a', now, visitasDocs: [visita] });
    assert.equal(r.visita?.id, 'v1');
  });

  it('el kiosco reconoce el QR como pase de visita', () => {
    const detected = detectAuthMethod(passCode);
    assert.equal(detected.method, 'dni');
    assert.equal(detected.passCode, passCode);
  });
});

const waitDirty = async (mem, visitaId) => {
  for (let i = 0; i < 50; i += 1) {
    const doc = mem.getDoc('sites/principal/compiled', '_dirty');
    if (doc && Array.isArray(doc.visitas) && doc.visitas.includes(visitaId)) return doc;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
};

describe('rutas de visitas: link público, cancelar y editar', () => {
  let mem;
  let srv;
  const futureIso = new Date(Date.now() + 2 * 86400000).toISOString();
  const futureEnd = new Date(Date.now() + 3 * 86400000).toISOString();
  const pastIso = new Date(Date.now() - 3 * 86400000).toISOString();
  const host = () => signTestToken({ id: 'host', role: 'empleado-visitas' });
  const requester = () => signTestToken({ id: 'req', role: 'empleado-solicitar-visitas' });
  const other = () => signTestToken({ id: 'otro', role: 'empleado-visitas' });
  const supervisor = () => signTestToken({ id: 'sup', role: 'supervisor' });

  let seq = 0;
  const visita = (extra = {}) => ({
    nombreVisitante: 'Ana Visitante',
    dniVisitante: '30111222',
    dniVisitanteNormalized: '30111222',
    fechaHoraEsperada: futureIso,
    inviteExpiresAt: futureEnd,
    destinoId: 'd1',
    destinoNombre: 'Planta',
    allowedDoorIds: [],
    estado: 'autorizada',
    createdByUserId: 'host',
    passCode: 'MSSV1.' + 'A'.repeat(32),
    inviteToken: `tok${(seq += 1)}`.padEnd(48, '0'),
    ...extra
  });

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    const user = (role) => ({ username: role, role, active: true, passwordVersion: 1, permissions: [], selfRegistered: false });
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          host: user('empleado-visitas'),
          req: user('empleado-solicitar-visitas'),
          otro: user('empleado-visitas'),
          sup: user('supervisor')
        },
        destinos: { d1: { nombre: 'Planta', activo: true, doorIds: [] }, d2: { nombre: 'Oficinas', activo: true, doorIds: [] } },
        visitas: {
          vOk: visita({ inviteToken: 'ok'.padEnd(48, '1') }),
          vVencida: visita({ inviteToken: 'old'.padEnd(48, '2'), fechaHoraEsperada: pastIso, inviteExpiresAt: pastIso }),
          vCancelada: visita({ inviteToken: 'can'.padEnd(48, '3'), estado: 'cancelada' }),
          vCancelar: visita(),
          vAjena: visita({ createdByUserId: 'otro' }),
          vEditar: visita(),
          vSolicitud: visita({ createdByUserId: 'req' }),
          vIngresada: visita({ estado: 'ingreso_registrado' })
        }
      }
    });
    srv = await startRouters(['routes/empleado.js']);
  });

  after(async () => { await srv.close(); });

  it('link vigente: devuelve passCode y DNI enmascarado, nunca el DNI completo', async () => {
    const res = await srv.request('GET', `/api/public/visita-invite/${'ok'.padEnd(48, '1')}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.invite.passCode, 'MSSV1.' + 'A'.repeat(32));
    assert.equal(res.body.invite.dniMasked, '***222');
    assert.equal(res.text.includes('30111222'), false);
  });

  it('link vencido → 410 con mensaje simple', async () => {
    const res = await srv.request('GET', `/api/public/visita-invite/${'old'.padEnd(48, '2')}`);
    assert.equal(res.status, 410);
    assert.match(res.body.message, /venció/);
  });

  it('visita cancelada → 410', async () => {
    const res = await srv.request('GET', `/api/public/visita-invite/${'can'.padEnd(48, '3')}`);
    assert.equal(res.status, 410);
    assert.match(res.body.message, /cancelada/);
  });

  it('cancelar: otro empleado no puede; el creador sí y se marca para el borde', async () => {
    const denied = await srv.request('POST', '/api/empleado/visitas/vCancelar/cancel', { token: other() });
    assert.equal(denied.status, 403);
    const res = await srv.request('POST', '/api/empleado/visitas/vCancelar/cancel', { token: host() });
    assert.equal(res.status, 200, res.text);
    assert.equal(mem.getDoc('visitas', 'vCancelar').estado, 'cancelada');
    assert.ok(await waitDirty(mem, 'vCancelar'));
    const again = await srv.request('POST', '/api/empleado/visitas/vCancelar/cancel', { token: host() });
    assert.equal(again.status, 400);
  });

  it('cancelar: quien tiene visitas.approve puede cancelar una ajena', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas/vAjena/cancel', { token: supervisor() });
    assert.equal(res.status, 200, res.text);
    assert.equal(mem.getDoc('visitas', 'vAjena').estado, 'cancelada');
  });

  it('no se puede cancelar una visita que ya ingresó', async () => {
    const res = await srv.request('POST', '/api/empleado/visitas/vIngresada/cancel', { token: host() });
    assert.equal(res.status, 400);
  });

  it('editar: regenera passCode e inviteToken, guarda el código anterior y marca para el borde', async () => {
    const before = mem.getDoc('visitas', 'vEditar');
    const denied = await srv.request('PATCH', '/api/empleado/visitas/vEditar', { token: other(), body: { motivo: 'x' } });
    assert.equal(denied.status, 403);
    const res = await srv.request('PATCH', '/api/empleado/visitas/vEditar', {
      token: host(),
      body: { motivo: 'Reunión', destinoId: 'd2' }
    });
    assert.equal(res.status, 200, res.text);
    const afterDoc = mem.getDoc('visitas', 'vEditar');
    assert.match(afterDoc.passCode, /^MSSV1\.[0-9A-F]{32}$/);
    assert.notEqual(afterDoc.passCode, before.passCode);
    assert.notEqual(afterDoc.inviteToken, before.inviteToken);
    assert.deepEqual(afterDoc.previousPassCodes, [before.passCode]);
    assert.equal(afterDoc.estado, 'autorizada');
    assert.equal(afterDoc.destinoNombre, 'Oficinas');
    assert.equal(afterDoc.motivo, 'Reunión');
    assert.ok(await waitDirty(mem, 'vEditar'));
    const oldLink = await srv.request('GET', `/api/public/visita-invite/${before.inviteToken}`);
    assert.equal(oldLink.status, 404);
  });

  it('editar: fecha inválida o destino inexistente → 400', async () => {
    const badDate = await srv.request('PATCH', '/api/empleado/visitas/vEditar', { token: host(), body: { fechaHoraEsperada: 'mañana' } });
    assert.equal(badDate.status, 400);
    const badDest = await srv.request('PATCH', '/api/empleado/visitas/vEditar', { token: host(), body: { destinoId: 'nope' } });
    assert.equal(badDest.status, 400);
  });

  it('editar con solo visitas.request: vuelve a pendiente de aprobación', async () => {
    const res = await srv.request('PATCH', '/api/empleado/visitas/vSolicitud', {
      token: requester(),
      body: { fechaHoraEsperada: futureIso }
    });
    assert.equal(res.status, 200, res.text);
    const doc = mem.getDoc('visitas', 'vSolicitud');
    assert.equal(doc.estado, 'pendiente_aprobacion');
    assert.equal(doc.inviteToken, null);
  });
});
