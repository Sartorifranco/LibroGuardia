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
  // Forzar apertura manual con la otra puerta del estanco abierta (motivo obligatorio, auditado).
  'puertas.estanco.forzar',
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
  'visitas.request',
  'visitas.approve',
  'visitas.view.own',
  'alarmas.ver',
  'alarmas.reconocer',
  // Grupos, horarios y feriados (jefe y Sistemas).
  'access.groups.manage',
  // Asignar grupos y acceso total a una persona (D3: jefe y Sistemas).
  'personas.puertas.asignar',
  'autorizaciones.solicitar',
  'autorizaciones.aprobar',
  'autorizaciones.aprobar_todas'
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
    // D4: el guardia puede forzar el estanco con motivo obligatorio (queda auditado).
    'puertas.estanco.forzar',
    'fleet.gps.read',
    'attendance.alerts.read',
    'guard.doors.panel',
    'alarmas.ver',
    'alarmas.reconocer',
    'autorizaciones.solicitar'
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
    // D12: borrar usuarios queda solo para Sistemas (admin); el supervisor desactiva.
    'roles.view',
    'access.manual_override',
    'access.manual_open',
    'puertas.estanco.forzar',
    'access.kiosk',
    'access.exceptional_entry',
    'attendance.alerts.read',
    'visitas.approve',
    'alarmas.ver',
    'alarmas.reconocer',
    'access.groups.manage',
    'personas.puertas.asignar',
    'autorizaciones.solicitar',
    'autorizaciones.aprobar_todas'
  ],
  'empleado-visitas': [
    'visitas.create',
    'visitas.view.own',
    'autorizaciones.solicitar'
  ],
  'empleado-solicitar-visitas': [
    'visitas.request',
    'visitas.view.own',
    'autorizaciones.solicitar'
  ],
  responsable: [
    'autorizaciones.aprobar',
    'autorizaciones.solicitar'
  ],
  admin: PERMISSION_KEYS.slice()
};

const normalizePlate = (value = '') => String(value).replace(/[\s-]/g, '').toUpperCase();

const resolvePermissions = (role, customPermissions = [], roleTemplates = null) => {
  const templates = roleTemplates || DEFAULT_ROLE_PERMISSIONS;
  // Fail-closed: un rol desconocido (sin plantilla en Firestore ni default) no hereda
  // permisos de otro rol. Solo cuenta lo explícito del usuario (customPermissions).
  const roleKey = String(role || '');
  const rolePerms = Object.prototype.hasOwnProperty.call(templates, roleKey)
    && Array.isArray(templates[roleKey])
    ? templates[roleKey]
    : [];
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
