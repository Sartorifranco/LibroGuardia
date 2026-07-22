const { normalizeIdNumber, parseScanData } = require('./dniParser');

const PERMISSION_KEYS = [
  'entries.create',
  'entries.view',
  'reports.export',
  'master.personal.read',
  'master.personal.write',
  'master.citaciones.read',
  'master.citaciones.write',
  'master.vehicles.read',
  'master.vehicles.write',
  'master.vehicles.quick_authorize',
  'fleet.upload',
  'users.view',
  'users.create',
  'users.edit',
  'users.delete',
  'roles.view',
  'roles.manage',
  'settings.permissions',
  'audit.view',
  'notifications.config',
  'access.control',
  'access.doors.manage',
  'access.manual_open',
  'access.manual_override',
  'access.exceptional_entry',
  'access.kiosk',
  'master.citaciones.preregister',
  'fleet.gps.read',
  'master.nomina.read',
  'master.nomina.write',
  'attendance.alerts.read',
  'monitoring.vehicles.manage',
  'monitoring.doors.panel',
  'guard.doors.panel',
  'empresas.manage',
  'destinos.manage',
  'lectores.manage',
  'visitas.create',
  'visitas.view.own'
];

const TECHNICAL_PERMISSIONS = [
  'access.control',
  'access.doors.manage',
  'settings.permissions',
  'roles.manage'
];

const DEFAULT_ROLE_PERMISSIONS = {
  monitoreo: [
    'entries.create',
    'entries.view',
    'reports.export',
    'master.vehicles.read',
    'master.vehicles.quick_authorize',
    'monitoring.vehicles.manage',
    'monitoring.doors.panel'
  ],
  guardia: [
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
  ],
  supervisor: [
    'entries.create',
    'entries.view',
    'reports.export',
    'master.personal.read',
    'master.personal.write',
    'master.citaciones.read',
    'master.citaciones.write',
    'master.citaciones.preregister',
    'master.nomina.read',
    'master.nomina.write',
    'master.vehicles.read',
    'master.vehicles.write',
    'master.vehicles.quick_authorize',
    'monitoring.vehicles.manage',
    'monitoring.doors.panel',
    'guard.doors.panel',
    'fleet.upload',
    'fleet.gps.read',
    'users.view',
    'users.create',
    'users.edit',
    'users.delete',
    'roles.view',
    'access.manual_override',
    'access.manual_open',
    'access.kiosk',
    'access.exceptional_entry',
    'attendance.alerts.read'
  ],
  'empleado-visitas': [
    'visitas.create',
    'visitas.view.own'
  ],
  admin: PERMISSION_KEYS.slice()
};

const normalizePlate = (value = '') => String(value).replace(/[\s-]/g, '').toUpperCase();

const resolvePermissions = (role, customPermissions = [], roleTemplates = null) => {
  const templates = roleTemplates || DEFAULT_ROLE_PERMISSIONS;
  const rolePerms = templates[role] || templates.guardia || [];
  const merged = new Set([...rolePerms, ...(Array.isArray(customPermissions) ? customPermissions : [])]);
  return [...merged];
};

module.exports = {
  PERMISSION_KEYS,
  TECHNICAL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  normalizeIdNumber,
  normalizePlate,
  parseScanData,
  resolvePermissions
};
