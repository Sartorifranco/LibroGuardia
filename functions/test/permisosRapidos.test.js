/**
 * Permisos rápidos: puertas por DNI, rol desconocido fail-closed, permisos de usuario,
 * roles fantasma, supervisor asignando roles y largo mínimo de contraseña.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupHarness,
  startRouters,
  defaultRoleDocs,
  signTestToken,
  TEST_JWT_SECRET
} = require('./helpers/routeHarness');

const user = (role, extra = {}) => ({
  username: extra.username || role,
  role,
  active: true,
  passwordVersion: 1,
  permissions: [],
  ...extra
});

const tokenFor = (id, role) => signTestToken({ id, role });

const waitAudit = async (mem, predicate) => {
  for (let i = 0; i < 20; i += 1) {
    for (let n = 1; n < 200; n += 1) {
      const doc = mem.getDoc('auditLog', `auto-${n}`);
      if (doc && predicate(doc)) return doc;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
};

describe('resolvePermissions: rol desconocido no hereda permisos', () => {
  const { resolvePermissions, DEFAULT_ROLE_PERMISSIONS } = require('../permissions');

  it('rol inexistente → solo permisos personalizados', () => {
    assert.deepEqual(resolvePermissions('rol_que_no_existe', []), []);
    assert.deepEqual(resolvePermissions('rol_que_no_existe', ['entries.view']), ['entries.view']);
    assert.deepEqual(resolvePermissions(undefined, []), []);
    assert.deepEqual(resolvePermissions('constructor', []), []);
    assert.deepEqual(resolvePermissions('__proto__', []), []);
  });

  it('roles conocidos y roles de Firestore (kiosk_puerta) siguen funcionando', () => {
    assert.deepEqual(
      resolvePermissions('guardia', []).sort(),
      [...DEFAULT_ROLE_PERMISSIONS.guardia].sort()
    );
    const templates = { ...DEFAULT_ROLE_PERMISSIONS, kiosk_puerta: ['access.kiosk'] };
    assert.deepEqual(resolvePermissions('kiosk_puerta', [], templates), ['access.kiosk']);
    // Aun sin doc de rol, el usuario técnico conserva su permiso explícito.
    assert.deepEqual(resolvePermissions('kiosk_puerta', ['access.kiosk']), ['access.kiosk']);
  });
});

describe('Rutas de puertas por DNI y administración de usuarios/roles', () => {
  let mem;
  let srv;

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs({
          operador: ['entries.create', 'entries.view'],
          // Rol no-sistema con un permiso que el supervisor no tiene.
          tecnico_plus: ['entries.view', 'access.doors.manage'],
          kiosk_puerta: ['access.kiosk']
        }),
        users: {
          admin: user('admin'),
          admin2: user('admin', { username: 'admin2' }),
          guardia: user('guardia'),
          guardia2: user('guardia', { username: 'guardia2' }),
          monitoreo: user('monitoreo'),
          supervisor: user('supervisor'),
          huerfano: user('rol_borrado'),
          tecnico: user('tecnico_plus')
        },
        people: {
          p1: { name: 'Juan', dniNormalized: '30111222', allowedDoorIds: ['d1'] }
        }
      }
    });
    // defaultRoleDocs no trae dashboardProfile: el supervisor real lo tiene.
    mem.setDoc('roles', 'supervisor', { ...mem.getDoc('roles', 'supervisor'), dashboardProfile: 'supervisor' });
    srv = await startRouters([
      'routes/peopleDoors.js',
      'routes/adminUsersRoles.js',
      'routes/entries.js'
    ]);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => {
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
  });

  describe('PUT /api/admin/people/by-dni/allowed-doors', () => {
    it('guardia y monitoreo (solo entries.create) → 403, sin cambios', async () => {
      for (const [id, role] of [['guardia', 'guardia'], ['monitoreo', 'monitoreo']]) {
        const res = await srv.request('PUT', '/api/admin/people/by-dni/allowed-doors', {
          token: tokenFor(id, role),
          body: { idNumber: '30111222', allowedDoorIds: ['d1', 'd2', 'd3'] }
        });
        assert.equal(res.status, 403, `${role}: ${res.text}`);
      }
      assert.deepEqual(mem.getDoc('people', 'p1').allowedDoorIds, ['d1']);
    });

    it('supervisor (master.nomina.write) puede y queda auditado con antes/después', async () => {
      const res = await srv.request('PUT', '/api/admin/people/by-dni/allowed-doors', {
        token: tokenFor('supervisor', 'supervisor'),
        body: { idNumber: '30111222', allowedDoorIds: ['d1', 'd2'] }
      });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(mem.getDoc('people', 'p1').allowedDoorIds, ['d1', 'd2']);
      const audit = await waitAudit(mem, (d) => d.action === 'person.allowed_doors.update' && d.targetId === 'p1');
      assert.ok(audit, 'falta auditoría');
      assert.deepEqual(audit.before.allowedDoorIds, ['d1']);
      assert.deepEqual(audit.after.allowedDoorIds, ['d1', 'd2']);
      assert.equal(audit.actorId, 'supervisor');
    });
  });

  it('usuario con rol inexistente no hereda permisos de guardia', async () => {
    const res = await srv.request('POST', '/api/entries', {
      token: tokenFor('huerfano', 'rol_borrado'),
      body: { type: 'personal', movementType: 'ingreso', name: 'X', idNumber: '30111222' }
    });
    assert.equal(res.status, 403, res.text);
  });

  describe('PUT /api/admin/users/:id/permissions', () => {
    it('no se puede auto-asignar permisos', async () => {
      const res = await srv.request('PUT', '/api/admin/users/admin/permissions', {
        token: tokenFor('admin', 'admin'),
        body: { permissions: ['audit.view'] }
      });
      assert.equal(res.status, 403, res.text);
    });

    it('admin asigna a otro usuario y queda auditado', async () => {
      const res = await srv.request('PUT', '/api/admin/users/guardia/permissions', {
        token: tokenFor('admin', 'admin'),
        body: { permissions: ['reports.export'] }
      });
      assert.equal(res.status, 200, res.text);
      const audit = await waitAudit(mem, (d) => d.action === 'user.permissions.update' && d.targetId === 'guardia');
      assert.ok(audit);
    });

    it('no-admin con settings.permissions no puede tocar usuarios fuera de su alcance ni otorgar lo que no tiene', async () => {
      mem.setDoc('users', 'supervisor', user('supervisor', { permissions: ['settings.permissions'] }));
      require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
      const toAdmin = await srv.request('PUT', '/api/admin/users/admin2/permissions', {
        token: tokenFor('supervisor', 'supervisor'),
        body: { permissions: [] }
      });
      assert.equal(toAdmin.status, 403, toAdmin.text);
      const escalate = await srv.request('PUT', '/api/admin/users/guardia2/permissions', {
        token: tokenFor('supervisor', 'supervisor'),
        body: { permissions: ['access.doors.manage'] }
      });
      assert.equal(escalate.status, 403, escalate.text);
      const ok = await srv.request('PUT', '/api/admin/users/guardia2/permissions', {
        token: tokenFor('supervisor', 'supervisor'),
        body: { permissions: ['reports.export'] }
      });
      assert.equal(ok.status, 200, ok.text);
      mem.setDoc('users', 'supervisor', user('supervisor'));
    });
  });

  it('PUT /api/admin/permissions/roles rechaza roles inexistentes sin escribir', async () => {
    const res = await srv.request('PUT', '/api/admin/permissions/roles', {
      token: tokenFor('admin', 'admin'),
      body: { roles: { guardia: ['entries.view'], rol_fantasma: ['users.view'] } }
    });
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(res.body.unknownRoles, ['rol_fantasma']);
    assert.equal(mem.hasDoc('roles', 'rol_fantasma'), false);
    assert.ok(mem.getDoc('roles', 'guardia').permissions.length > 1, 'no debe aplicar cambios parciales');
  });

  describe('supervisor asignando roles', () => {
    it('no puede crear usuarios con un rol con más permisos que los suyos', async () => {
      const res = await srv.request('POST', '/api/admin/users', {
        token: tokenFor('supervisor', 'supervisor'),
        body: { username: 'nuevo.tecnico', password: 'Segura12345', role: 'tecnico_plus' }
      });
      assert.equal(res.status, 403, res.text);
    });

    it('puede crear guardia y rol no-sistema con permisos incluidos en los suyos', async () => {
      for (const [username, role] of [['nuevo.guardia', 'guardia'], ['nuevo.operador', 'operador']]) {
        const res = await srv.request('POST', '/api/admin/users', {
          token: tokenFor('supervisor', 'supervisor'),
          body: { username, password: 'Segura12345', role }
        });
        assert.equal(res.status, 201, `${role}: ${res.text}`);
      }
    });

    it('no puede cambiar a un usuario a un rol más amplio', async () => {
      const res = await srv.request('PUT', '/api/admin/users/guardia2', {
        token: tokenFor('supervisor', 'supervisor'),
        body: { role: 'tecnico_plus' }
      });
      assert.equal(res.status, 403, res.text);
      assert.equal(mem.getDoc('users', 'guardia2').role, 'guardia');
    });
  });

  describe('largo mínimo de contraseña', () => {
    it('alta de usuario con contraseña corta → 400', async () => {
      const res = await srv.request('POST', '/api/admin/users', {
        token: tokenFor('admin', 'admin'),
        body: { username: 'corto', password: '123456', role: 'guardia' }
      });
      assert.equal(res.status, 400, res.text);
      assert.match(res.body.message, /8 caracteres/);
      assert.equal(mem.hasDoc('users', 'corto'), false);
    });

    it('reset admin con contraseña corta → 400; con 8+ → 200', async () => {
      const bad = await srv.request('PUT', '/api/admin/users/guardia', {
        token: tokenFor('admin', 'admin'),
        body: { password: 'abc' }
      });
      assert.equal(bad.status, 400, bad.text);
      const ok = await srv.request('PUT', '/api/admin/users/guardia', {
        token: tokenFor('admin', 'admin'),
        body: { password: 'NuevaClave2026' }
      });
      assert.equal(ok.status, 200, ok.text);
    });
  });
});

describe('POST /api/guard/open-door: estanco forzado', () => {
  let mem;
  let srv;
  const calls = [];

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs(),
        users: {
          admin: user('admin'),
          guardia: user('guardia'),
          supervisor: user('supervisor'),
          // Rol sin el permiso de forzar: solo apertura manual.
          operador: user('operador_puertas', { username: 'operador', permissions: ['access.manual_open'] })
        }
      },
      stubs: {
        'accessControl.js': {
          triggerAccessIfAuthorized: async () => ({ authorized: false }),
          processKioskScan: async () => ({}),
          validarAcceso: async () => ({ autorizado: false }),
          evaluatePersonalAccess: async () => ({ authorized: false }),
          manualOpenDoor: async (args) => {
            calls.push(args);
            if (!args.forceAirlock) {
              const err = new Error('No se puede abrir: la otra puerta del estanco (Exterior) está abierta. Esperá a que se cierre.');
              err.status = 409;
              err.code = 'AIRLOCK_OTHER_OPEN';
              err.airlock = { allowed: false, forcible: true };
              throw err;
            }
            return {
              message: 'Interior abierta manualmente',
              door: { id: 'int', name: 'Interior' },
              airlock: { groupId: 'estanco-1' },
              forcedAirlock: { phase: 'outer_open', otherDoorName: 'Exterior' }
            };
          }
        },
        'lib/guardLocalStations.js': {
          enrichDoorsWithLocalStations: async (doors) => doors
        }
      }
    });
    srv = await startRouters(['routes/access.js']);
  });

  after(async () => { await srv.close(); });

  beforeEach(() => {
    calls.length = 0;
    require('../lib/passwordVersion')._clearPasswordVersionCacheForTests();
  });

  it('sin forzar: 409 con mensaje y code; bypassAirlock del body se ignora', async () => {
    const res = await srv.request('POST', '/api/guard/open-door', {
      token: tokenFor('guardia', 'guardia'),
      body: { doorId: 'int', bypassAirlock: true }
    });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.code, 'AIRLOCK_OTHER_OPEN');
    assert.match(res.body.message, /Esperá a que se cierre/);
    assert.equal(calls[0].forceAirlock, false);
    assert.equal('bypassAirlock' in calls[0], false);
  });

  it('sin puertas.estanco.forzar no puede forzar (403)', async () => {
    const res = await srv.request('POST', '/api/guard/open-door', {
      token: tokenFor('operador', 'operador_puertas'),
      body: { doorId: 'int', forceAirlock: true, forceReason: 'Emergencia médica' }
    });
    assert.equal(res.status, 403, res.text);
    assert.equal(calls.length, 0);
  });

  it('guardia (decisión D4) puede forzar con motivo y queda auditado', async () => {
    const res = await srv.request('POST', '/api/guard/open-door', {
      token: tokenFor('guardia', 'guardia'),
      body: { doorId: 'int', forceAirlock: true, forceReason: 'Emergencia médica' }
    });
    assert.equal(res.status, 200, res.text);
    const audit = await waitAudit(mem, (d) => d.action === 'door.airlock.force_open' && d.actorId === 'guardia');
    assert.ok(audit, 'falta auditoría del forzado del guardia');
    assert.equal(audit.after.reason, 'Emergencia médica');
  });

  it('supervisor: motivo obligatorio (400)', async () => {
    const res = await srv.request('POST', '/api/guard/open-door', {
      token: tokenFor('supervisor', 'supervisor'),
      body: { doorId: 'int', forceAirlock: true, forceReason: '  ' }
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(calls.length, 0);
  });

  it('supervisor con motivo: abre forzado y queda auditado', async () => {
    const res = await srv.request('POST', '/api/guard/open-door', {
      token: tokenFor('supervisor', 'supervisor'),
      body: { doorId: 'int', forceAirlock: true, forceReason: 'Evacuación por humo' }
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(calls[0].forceAirlock, true);
    assert.match(calls[0].reason, /Evacuación por humo/);
    const audit = await waitAudit(mem, (d) => d.action === 'door.airlock.force_open' && d.actorId === 'supervisor');
    assert.ok(audit, 'falta auditoría del forzado');
    assert.equal(audit.actorId, 'supervisor');
    assert.equal(audit.after.reason, 'Evacuación por humo');
    assert.equal(audit.after.forcedAirlock, true);
    assert.equal(audit.targetId, 'int');
  });
});

describe('Login: bloqueo de cuentas técnicas por usuario+IP', () => {
  let mem;
  let srv;
  const KIOSK_PASS = 'Ab3dEf6hIj9kLm2nOp5qRs8t';
  const HUMAN_PASS = 'Guardia12345';

  before(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    const bcrypt = require('bcryptjs');
    mem = setupHarness({
      initial: {
        roles: defaultRoleDocs({ kiosk_puerta: ['access.kiosk'] }),
        users: {
          'kiosk.p1.l1': user('kiosk_puerta', {
            username: 'kiosk.p1.l1',
            password: bcrypt.hashSync(KIOSK_PASS, 4),
            permissions: ['access.kiosk']
          }),
          'estacion.legacy': user('kiosk_puerta', {
            username: 'estacion.legacy',
            password: bcrypt.hashSync(KIOSK_PASS, 4)
          }),
          guardia: user('guardia', { password: bcrypt.hashSync(HUMAN_PASS, 4) })
        }
      }
    });
    srv = await startRouters(['routes/auth.js']);
  });

  after(async () => { await srv.close(); });

  const login = (username, password, ip) => srv.request('POST', '/api/auth/login', {
    body: { username, password },
    headers: { 'x-forwarded-for': ip }
  });

  it('equipo viejo en otra IP: se bloquea solo esa IP, la estación legítima sigue entrando y queda alerta', async () => {
    const ok = await login('kiosk.p1.l1', KIOSK_PASS, '10.0.0.1');
    assert.equal(ok.status, 200, ok.text);

    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await login('kiosk.p1.l1', 'clave-vieja', '10.9.9.9');
    }
    assert.equal(last.status, 429, last.text);

    const legit = await login('kiosk.p1.l1', KIOSK_PASS, '10.0.0.1');
    assert.equal(legit.status, 200, `la estación legítima no debe quedar bloqueada: ${legit.text}`);

    const stale = await login('kiosk.p1.l1', KIOSK_PASS, '10.9.9.9');
    assert.equal(stale.status, 429, 'la IP del equipo viejo sigue bloqueada');

    const alert = mem.getDoc('deviceAlerts', 'credenciales_viejas__kiosk.p1.l1__10.9.9.9');
    assert.ok(alert, 'falta alerta de credenciales viejas');
    assert.equal(alert.kind, 'credenciales_viejas');
    assert.equal(alert.username, 'kiosk.p1.l1');
    assert.equal(alert.ip, '10.9.9.9');
    assert.equal(alert.lastSuccessIp, '10.0.0.1');
    assert.equal(typeof alert.at, 'number');
  });

  it('rol kiosk_puerta sin prefijo kiosk. también se trata como técnica', async () => {
    for (let i = 0; i < 6; i += 1) {
      await login('estacion.legacy', 'mala', '10.8.8.8');
    }
    const legit = await login('estacion.legacy', KIOSK_PASS, '10.0.0.2');
    assert.equal(legit.status, 200, legit.text);
  });

  it('cuentas humanas mantienen el bloqueo por usuario (cualquier IP)', async () => {
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await login('guardia', 'mala', '10.7.7.7');
    }
    assert.equal(last.status, 429, last.text);
    const other = await login('guardia', HUMAN_PASS, '10.0.0.3');
    assert.equal(other.status, 429, other.text);
    assert.equal(mem.hasDoc('deviceAlerts', 'credenciales_viejas__guardia__10.7.7.7'), false);
  });
});
