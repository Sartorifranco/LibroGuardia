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
