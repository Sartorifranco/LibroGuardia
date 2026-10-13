import { canAccessAdmin, canManageTargetUser } from './permissions';

const GUARDIA_PERMS = [
  'entries.create',
  'entries.view',
  'reports.export',
  'master.personal.read',
  'master.personal.write',
  'master.citaciones.read',
  'master.citaciones.preregister',
  'master.vehicles.read',
  'access.kiosk',
  'access.manual_open',
  'access.exceptional_entry',
  'fleet.gps.read',
  'attendance.alerts.read',
  'guard.doors.panel'
];

describe('canAccessAdmin', () => {
  it('un guardia (master.personal.write) no ve el panel admin', () => {
    expect(canAccessAdmin({ role: 'guardia', permissions: GUARDIA_PERMS })).toBe(false);
  });

  it('auditoría sola sí da acceso (sección Actividad / Auditoría)', () => {
    expect(canAccessAdmin({ role: 'x', permissions: ['audit.view'] })).toBe(true);
  });
});

describe('canManageTargetUser (misma regla que el backend)', () => {
  const supervisor = {
    id: 'sup',
    role: 'supervisor',
    dashboardProfile: 'supervisor',
    permissions: [...GUARDIA_PERMS, 'users.view', 'users.edit']
  };
  const roles = [
    { id: 'guardia', isSystem: true, permissions: GUARDIA_PERMS },
    { id: 'monitoreo', isSystem: true, permissions: ['entries.create'] },
    { id: 'supervisor', isSystem: true, permissions: supervisor.permissions },
    { id: 'operador', isSystem: false, permissions: ['entries.view'] },
    { id: 'tecnico_plus', isSystem: false, permissions: ['access.doors.manage'] }
  ];

  it('supervisor: guardia y roles no-sistema con permisos incluidos', () => {
    expect(canManageTargetUser(supervisor, { role: 'guardia' }, roles)).toBe(true);
    expect(canManageTargetUser(supervisor, { role: 'operador' }, roles)).toBe(true);
  });

  it('supervisor: no admin, no otros supervisores, no roles con más permisos', () => {
    expect(canManageTargetUser(supervisor, { role: 'admin' }, roles)).toBe(false);
    expect(canManageTargetUser(supervisor, { role: 'supervisor' }, roles)).toBe(false);
    expect(canManageTargetUser(supervisor, { role: 'tecnico_plus' }, roles)).toBe(false);
  });

  it('guardia no gestiona usuarios', () => {
    expect(canManageTargetUser({ role: 'guardia', permissions: GUARDIA_PERMS }, { role: 'monitoreo' }, roles)).toBe(false);
  });

  it('admin gestiona no-admins y a sí mismo', () => {
    const admin = { id: 'admin', role: 'admin' };
    expect(canManageTargetUser(admin, { id: 'g', role: 'guardia' }, roles)).toBe(true);
    expect(canManageTargetUser(admin, { id: 'admin', role: 'admin' }, roles)).toBe(true);
    expect(canManageTargetUser(admin, { id: 'otro', role: 'admin' }, roles)).toBe(false);
  });
});
