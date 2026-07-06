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
  'settings.permissions',
  'access.control',
  'access.manual_override',
  'access.exceptional_entry',
  'access.kiosk',
  'master.citaciones.preregister',
  'fleet.gps.read',
  'master.nomina.read',
  'master.nomina.write',
  'attendance.alerts.read'
];

const DEFAULT_ROLE_PERMISSIONS = {
  guardia: [
    'entries.create',
    'entries.view',
    'reports.export',
    'master.personal.read',
    'master.personal.write',
    'master.citaciones.read',
    'master.citaciones.preregister',
    'master.vehicles.read',
    'master.vehicles.quick_authorize',
    'access.kiosk',
    'access.exceptional_entry',
    'fleet.gps.read',
    'attendance.alerts.read'
  ],
  supervisor: [
    'entries.create',
    'entries.view',
    'reports.export',
    'master.personal.read',
    'master.personal.write',
    'master.citaciones.read',
    'master.citaciones.write',
    'master.nomina.read',
    'master.nomina.write',
    'master.vehicles.read',
    'master.vehicles.write',
    'master.vehicles.quick_authorize',
    'fleet.upload',
    'users.view',
    'users.edit',
    'users.delete',
    'access.manual_override',
    'attendance.alerts.read'
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
  DEFAULT_ROLE_PERMISSIONS,
  normalizeIdNumber,
  normalizePlate,
  parseScanData,
  resolvePermissions
};
