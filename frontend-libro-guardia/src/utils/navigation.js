import {
  LayoutDashboard,
  User,
  Car,
  Truck,
  ClipboardList,
  Scan,
  FileText,
  List,
  ShieldCheck,
  CalendarCheck,
  DoorOpen,
  Radio
} from 'lucide-react';
import { hasPermission } from './permissions';

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
      label: 'Novedades',
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
      label: 'Novedades',
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
      label: 'Novedades',
      icon: ClipboardList
    });
  }

  addIf(hasPermission(user, 'reports.export'), { id: 'reportes', label: 'Reportes', icon: FileText });
  addIf(hasPermission(user, 'entries.view'), {
    id: 'allRecords',
    label: 'Todos los registros',
    icon: List
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
