import {
  LayoutDashboard,
  User,
  Car,
  Truck,
  ClipboardList,
  Scan,
  History,
  ShieldCheck,
  CalendarCheck,
  DoorOpen,
  Radio,
  BarChart3
} from 'lucide-react';
import { canAccessAdmin, canAccessEmpleado, canAccessGuardia, hasPermission } from './permissions';

/** Acceso a la pantalla unificada Historial (ver y/o exportar). */
export const canAccessHistorial = (user) =>
  hasPermission(user, 'entries.view') || hasPermission(user, 'reports.export');

/** Panel gerencial de reportes agregados (solo reports.export). */
export const canAccessReportes = (user) => hasPermission(user, 'reports.export');

export { canAccessGuardia, canAccessEmpleado };

/** tab id (legado) → segmento de ruta bajo /guardia */
export const GUARDIA_TAB_SEGMENTS = {
  inicio: 'inicio',
  personal: 'personal',
  vehiculo: 'vehiculo',
  flota: 'flota',
  novedad: 'novedad',
  historial: 'historial',
  allRecords: 'historial',
  reportes: 'reportes',
  kiosk: 'kiosk',
  citados: 'citados',
  autorizados: 'autorizados',
  vehiculosAutorizados: 'vehiculos-autorizados',
  botoneraMonitoreo: 'botonera-monitoreo',
  botoneraGuardia: 'botonera-guardia'
};

/** segmento → tab id */
export const GUARDIA_SEGMENT_TO_TAB = Object.entries(GUARDIA_TAB_SEGMENTS).reduce((acc, [tab, seg]) => {
  if (!acc[seg]) acc[seg] = tab === 'allRecords' ? 'historial' : tab;
  return acc;
}, {});

/** adminSection id → segmento bajo /admin */
export const ADMIN_SECTION_SEGMENTS = {
  users: 'users',
  roles: 'roles',
  activity: 'activity',
  audit: 'audit',
  notifications: 'notifications',
  doors: 'doors',
  peopleAccess: 'people-access',
  access: 'access',
  citaciones: 'citaciones',
  nomina: 'nomina',
  vehicles: 'vehicles',
  fleet: 'fleet',
  empresas: 'empresas',
  destinos: 'destinos',
  permissions: 'permissions'
};

export const ADMIN_SEGMENT_TO_SECTION = Object.entries(ADMIN_SECTION_SEGMENTS).reduce((acc, [section, seg]) => {
  acc[seg] = section;
  return acc;
}, {});

export const guardiaPath = (tabId = 'inicio') => {
  const segment = GUARDIA_TAB_SEGMENTS[tabId] || GUARDIA_TAB_SEGMENTS.inicio;
  return `/guardia/${segment}`;
};

export const adminPath = (sectionId = 'users') => {
  const segment = ADMIN_SECTION_SEGMENTS[sectionId] || ADMIN_SECTION_SEGMENTS.users;
  return `/admin/${segment}`;
};

export const tabFromGuardiaSegment = (segment) =>
  GUARDIA_SEGMENT_TO_TAB[segment] || 'inicio';

export const sectionFromAdminSegment = (segment) =>
  ADMIN_SEGMENT_TO_SECTION[segment] || null;

/**
 * Destino post-login / raíz autenticada.
 * Criterio: solo guardia → /guardia; solo admin → /admin;
 * ambos → / (selector); solo empleado-visitas → /empleado.
 */
export const resolveHomePath = (user) => {
  const guardia = canAccessGuardia(user);
  const admin = canAccessAdmin(user);
  const empleado = canAccessEmpleado(user);
  if (empleado && !guardia && !admin) return '/empleado';
  if (guardia && admin) return '/';
  if (admin) return '/admin';
  if (guardia) return '/guardia';
  if (empleado) return '/empleado';
  return '/login';
};

/** Primera sección admin visible según permisos.
 * Orden = grupos de nav en AdminPage (Personas → Infra → Maestros → Supervisión).
 * Solo se usa cuando no hay segmento válido en la URL; deep-links (/admin/doors, etc.)
 * siguen resolviendo por sectionFromAdminSegment y no pasan por acá.
 */
const ADMIN_DEFAULT_SECTION_ORDER = [
  { id: 'users', match: (u) => hasPermission(u, 'users.view') },
  { id: 'roles', match: (u) => hasPermission(u, 'roles.view') || hasPermission(u, 'roles.manage') },
  { id: 'permissions', match: (u) => hasPermission(u, 'settings.permissions') },
  {
    id: 'peopleAccess',
    match: (u) =>
      hasPermission(u, 'access.doors.manage')
      || hasPermission(u, 'access.control')
      || hasPermission(u, 'master.nomina.write')
  },
  {
    id: 'doors',
    match: (u) => hasPermission(u, 'access.doors.manage') || hasPermission(u, 'access.control')
  },
  { id: 'notifications', match: (u) => hasPermission(u, 'notifications.config') },
  { id: 'access', match: (u) => hasPermission(u, 'access.control') },
  { id: 'nomina', match: (u) => hasPermission(u, 'master.nomina.write') },
  { id: 'citaciones', match: (u) => hasPermission(u, 'master.citaciones.write') },
  { id: 'vehicles', match: (u) => hasPermission(u, 'master.vehicles.write') },
  { id: 'fleet', match: (u) => hasPermission(u, 'fleet.upload') },
  { id: 'empresas', match: (u) => hasPermission(u, 'empresas.manage') },
  { id: 'destinos', match: (u) => hasPermission(u, 'destinos.manage') },
  {
    id: 'activity',
    match: (u) =>
      hasPermission(u, 'users.view')
      || hasPermission(u, 'roles.view')
      || hasPermission(u, 'settings.permissions')
  },
  { id: 'audit', match: (u) => hasPermission(u, 'audit.view') }
];

export const getDefaultAdminSection = (user) => {
  if (!user) return 'users';
  for (const item of ADMIN_DEFAULT_SECTION_ORDER) {
    if (item.match(user)) return item.id;
  }
  return 'users';
};

export const buildSidebarItems = (user) => {
  if (!user) return [];

  const profile = user.dashboardProfile || user.role;
  const items = [{ id: 'inicio', label: 'Inicio', icon: LayoutDashboard }];

  const addIf = (condition, item) => {
    if (condition) items.push(item);
  };

  if (profile === 'monitoreo') {
    addIf(
      hasPermission(user, 'monitoring.vehicles.manage') || hasPermission(user, 'master.vehicles.quick_authorize'),
      { id: 'vehiculosAutorizados', label: 'Vehículos autorizados', icon: Car }
    );
    addIf(hasPermission(user, 'monitoring.doors.panel'), {
      id: 'botoneraMonitoreo',
      label: 'Botonera portón',
      icon: DoorOpen
    });
    addIf(hasPermission(user, 'entries.create'), {
      id: 'novedad',
      label: 'Cargar novedad',
      icon: ClipboardList
    });
  } else if (profile === 'guardia') {
    addIf(hasPermission(user, 'entries.create'), { id: 'personal', label: 'Personal', icon: User });
    addIf(hasPermission(user, 'entries.create'), {
      id: 'vehiculo',
      label: 'Vehículos externos',
      icon: Car
    });
    addIf(hasPermission(user, 'fleet.gps.read') || hasPermission(user, 'entries.create'), {
      id: 'flota',
      label: 'Unidades blindadas',
      icon: Truck
    });
    addIf(hasPermission(user, 'attendance.alerts.read'), {
      id: 'citados',
      label: 'Citados',
      icon: CalendarCheck
    });
    addIf(hasPermission(user, 'master.citaciones.read'), {
      id: 'autorizados',
      label: 'Autorizados',
      icon: ShieldCheck
    });
    addIf(hasPermission(user, 'guard.doors.panel'), {
      id: 'botoneraGuardia',
      label: 'Botonera portón',
      icon: DoorOpen
    });
    addIf(hasPermission(user, 'access.kiosk'), {
      id: 'kiosk',
      label: 'Molinete / Acceso',
      icon: Scan
    });
    addIf(hasPermission(user, 'entries.create'), {
      id: 'novedad',
      label: 'Cargar novedad',
      icon: ClipboardList
    });
  } else {
    addIf(hasPermission(user, 'attendance.alerts.read'), {
      id: 'citados',
      label: 'Citados',
      icon: CalendarCheck
    });
    addIf(hasPermission(user, 'master.citaciones.read'), {
      id: 'autorizados',
      label: 'Autorizados',
      icon: ShieldCheck
    });
    addIf(hasPermission(user, 'entries.create'), { id: 'personal', label: 'Personal', icon: User });
    addIf(hasPermission(user, 'entries.create'), {
      id: 'vehiculo',
      label: 'Vehículos externos',
      icon: Car
    });
    addIf(
      hasPermission(user, 'monitoring.vehicles.manage') || hasPermission(user, 'master.vehicles.quick_authorize'),
      { id: 'vehiculosAutorizados', label: 'Vehículos autorizados', icon: Car }
    );
    addIf(hasPermission(user, 'fleet.gps.read') || hasPermission(user, 'entries.create'), {
      id: 'flota',
      label: 'Flota / blindados',
      icon: Truck
    });
    addIf(hasPermission(user, 'monitoring.doors.panel'), {
      id: 'botoneraMonitoreo',
      label: 'Botonera Monitoreo',
      icon: Radio
    });
    addIf(hasPermission(user, 'guard.doors.panel'), {
      id: 'botoneraGuardia',
      label: 'Botonera Guardia',
      icon: DoorOpen
    });
    addIf(hasPermission(user, 'access.kiosk'), {
      id: 'kiosk',
      label: 'Molinete / Acceso',
      icon: Scan
    });
    addIf(hasPermission(user, 'entries.create'), {
      id: 'novedad',
      label: 'Cargar novedad',
      icon: ClipboardList
    });
  }

  addIf(canAccessHistorial(user), {
    id: 'historial',
    label: 'Historial',
    icon: History
  });

  addIf(canAccessReportes(user), {
    id: 'reportes',
    label: 'Reportes',
    icon: BarChart3
  });

  return items;
};

export const getProfileKicker = (user) => {
  const profile = user?.dashboardProfile || user?.role;
  const labels = {
    monitoreo: 'Puesto de Monitoreo',
    guardia: 'Puesto de Guardia',
    supervisor: 'Supervisión operativa',
    admin: 'Administración general'
  };
  return labels[profile] || 'Operación';
};
