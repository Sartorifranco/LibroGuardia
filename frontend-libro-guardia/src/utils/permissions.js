export const PERMISSION_LABELS = {
  'entries.create': 'Registrar movimientos',
  'entries.view': 'Ver registros',
  'reports.export': 'Exportar reportes',
  'master.personal.read': 'Ver personal precargado',
  'master.personal.write': 'Cargar personal precargado',
  'master.citaciones.read': 'Ver citaciones',
  'master.citaciones.write': 'Gestionar citaciones',
  'master.vehicles.read': 'Ver vehículos autorizados',
  'master.vehicles.write': 'Precargar vehículos autorizados',
  'master.vehicles.quick_authorize': 'Autorizar vehículo rápido',
  'fleet.upload': 'Cargar listas de flota',
  'users.view': 'Ver usuarios',
  'users.create': 'Crear usuarios',
  'users.edit': 'Editar usuarios',
  'users.delete': 'Eliminar usuarios',
  'roles.view': 'Ver roles',
  'roles.manage': 'Gestionar roles',
  'settings.permissions': 'Configurar permisos',
  'access.control': 'Configurar GPS flota UBIKA',
  'access.doors.manage': 'Configurar puertas, estancos y dispositivos',
  'access.manual_open': 'Abrir puerta manualmente (SR201)',
  'access.manual_override': 'Autorizar ingreso manual sin citación',
  'access.exceptional_entry': 'Registrar ingreso excepcional con motivo',
  'access.kiosk': 'Usar pantalla de molinete',
  'master.citaciones.preregister': 'Pre-registrar visitas esperadas',
  'fleet.gps.read': 'Ver alertas GPS de flota cercana',
  'master.nomina.read': 'Ver nómina de personal',
  'master.nomina.write': 'Importar y gestionar nómina',
  'attendance.alerts.read': 'Ver alertas de asistencia (faltantes de ingreso)',
  'monitoring.vehicles.manage': 'Autorizar vehículos con chofer y acompañantes (Monitoreo)',
  'monitoring.doors.panel': 'Botonera digital portón Monitoreo',
  'guard.doors.panel': 'Botonera digital portón Guardia'
};

/** Agrupación de permisos para la UI de roles (nombres de uso diario). */
export const PERMISSION_CATEGORIES = [
  {
    id: 'registro',
    label: 'Registro diario',
    permissions: ['entries.create', 'entries.view', 'access.kiosk', 'access.exceptional_entry']
  },
  {
    id: 'personal',
    label: 'Personal y visitas',
    permissions: [
      'master.personal.read',
      'master.personal.write',
      'master.citaciones.read',
      'master.citaciones.write',
      'master.citaciones.preregister',
      'master.nomina.read',
      'master.nomina.write',
      'attendance.alerts.read'
    ]
  },
  {
    id: 'vehiculos',
    label: 'Vehículos y flota',
    permissions: [
      'master.vehicles.read',
      'master.vehicles.write',
      'master.vehicles.quick_authorize',
      'fleet.upload',
      'fleet.gps.read',
      'monitoring.vehicles.manage'
    ]
  },
  {
    id: 'puertas',
    label: 'Puertas y accesos físicos',
    permissions: [
      'access.control',
      'access.doors.manage',
      'access.manual_open',
      'access.manual_override',
      'monitoring.doors.panel',
      'guard.doors.panel'
    ]
  },
  {
    id: 'admin',
    label: 'Administración del sistema',
    permissions: [
      'users.view',
      'users.create',
      'users.edit',
      'users.delete',
      'roles.view',
      'roles.manage',
      'settings.permissions'
    ]
  },
  {
    id: 'reportes',
    label: 'Reportes',
    permissions: ['reports.export']
  }
];

export const TECHNICAL_PERMISSIONS = [
  'access.control',
  'access.doors.manage',
  'settings.permissions',
  'roles.manage'
];

export const DASHBOARD_PROFILE_LABELS = {
  monitoreo: 'Monitoreo',
  guardia: 'Guardia',
  supervisor: 'Supervisor',
  admin: 'Administración',
  operational: 'Operación'
};

/** Plantillas rápidas al crear un rol (espejo de DEFAULT_ROLE_PERMISSIONS del backend). */
export const ROLE_TEMPLATES = {
  guardia: {
    label: 'Guardia',
    description: 'Portón de unidades blindadas y acceso principal a planta. Personal, molinete y novedades.',
    dashboardProfile: 'guardia',
    permissions: [
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
    ]
  },
  supervisor: {
    label: 'Supervisor',
    description: 'Operación completa de guardia y monitoreo, gestión de maestros y usuarios. Sin configuración técnica.',
    dashboardProfile: 'supervisor',
    permissions: [
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
    ]
  },
  monitoreo: {
    label: 'Monitoreo',
    description: 'Portón de vehículos livianos, directivos, clientes y grúas. Autorización de vehículos y novedades.',
    dashboardProfile: 'monitoreo',
    permissions: [
      'entries.create',
      'entries.view',
      'reports.export',
      'master.vehicles.read',
      'master.vehicles.quick_authorize',
      'monitoring.vehicles.manage',
      'monitoring.doors.panel'
    ]
  },
  admin: {
    label: 'Admin',
    description: 'Acceso total al sistema incluyendo configuración técnica.',
    dashboardProfile: 'admin',
    permissions: Object.keys(PERMISSION_LABELS)
  }
};

export const slugifyRoleId = (value = '') => String(value)
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 48);

/**
 * Categorías visibles + permisos huérfanos en "Otros".
 * @param {string[]} permissionKeys
 */
export const buildPermissionCategories = (permissionKeys = Object.keys(PERMISSION_LABELS)) => {
  const known = new Set(permissionKeys);
  const used = new Set();
  const categories = PERMISSION_CATEGORIES.map((cat) => {
    const permissions = cat.permissions.filter((p) => known.has(p));
    permissions.forEach((p) => used.add(p));
    return { ...cat, permissions };
  }).filter((cat) => cat.permissions.length > 0);

  const leftovers = permissionKeys.filter((p) => !used.has(p));
  if (leftovers.length) {
    categories.push({ id: 'otros', label: 'Otros', permissions: leftovers });
  }
  return categories;
};

export const hasPermission = (user, permission) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
};

export const getDashboardProfile = (user) =>
  user?.dashboardProfile || user?.role || 'operational';

export const canAccessAdmin = (user) =>
  hasPermission(user, 'users.view') ||
  hasPermission(user, 'roles.view') ||
  hasPermission(user, 'master.personal.write') ||
  hasPermission(user, 'master.vehicles.write') ||
  hasPermission(user, 'master.citaciones.write') ||
  hasPermission(user, 'master.nomina.write') ||
  hasPermission(user, 'fleet.upload') ||
  hasPermission(user, 'settings.permissions') ||
  hasPermission(user, 'access.control') ||
  hasPermission(user, 'access.doors.manage');

export const canManageUsers = (user) =>
  hasPermission(user, 'users.create') ||
  hasPermission(user, 'users.edit') ||
  hasPermission(user, 'users.delete');

export const canManageTargetUser = (actor, targetUser) => {
  if (!actor || !targetUser) return false;
  if (actor.role === 'admin') return targetUser.role !== 'admin' || actor.id === targetUser.id;
  if (actor.role === 'supervisor') return ['guardia', 'monitoreo'].includes(targetUser.role);
  return false;
};
