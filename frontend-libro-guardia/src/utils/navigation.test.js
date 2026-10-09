import {
  adminPath,
  buildSidebarItems,
  guardiaPath,
  resolveHomePath,
  sectionFromAdminSegment,
  tabFromGuardiaSegment,
  getDefaultAdminSection
} from './navigation';
import { canAccessAdmin, canAccessEmpleado, canAccessGuardia } from './permissions';

describe('navigation routes', () => {
  test('guardiaPath y adminPath generan URLs esperadas', () => {
    expect(guardiaPath('inicio')).toBe('/guardia/inicio');
    expect(guardiaPath('kiosk')).toBe('/guardia/kiosk');
    expect(guardiaPath('botonera')).toBe('/guardia/botonera');
    expect(guardiaPath('botonera-ventana')).toBe('/guardia/botonera-ventana');
    expect(guardiaPath('botoneraMonitoreo')).toBe('/guardia/botonera');
    expect(guardiaPath('botoneraGuardia')).toBe('/guardia/botonera');
    expect(guardiaPath('vehiculosAutorizados')).toBe('/guardia/vehiculos-autorizados');
    expect(adminPath('users')).toBe('/admin/users');
    expect(adminPath('peopleAccess')).toBe('/admin/personas');
    expect(adminPath('equiposAcceso')).toBe('/admin/sistemas');
    expect(adminPath('doors')).toBe('/admin/puertas');
    expect(adminPath('puertas')).toBe('/admin/puertas');
    expect(adminPath('lectores')).toBe('/admin/sistemas');
    expect(adminPath('visitas')).toBe('/admin/visitas');
    expect(adminPath('appearance')).toBe('/admin/datos-empresa');
    expect(adminPath('negocioAccesos')).toBe('/admin/grupos');
    expect(adminPath('primerosPasos')).toBe('/admin/primeros-pasos');
  });

  test('segmentos se mapean de vuelta a tabs/secciones', () => {
    expect(tabFromGuardiaSegment('vehiculos-autorizados')).toBe('vehiculosAutorizados');
    expect(tabFromGuardiaSegment('historial')).toBe('historial');
    expect(tabFromGuardiaSegment('botonera')).toBe('botonera');
    expect(tabFromGuardiaSegment('botonera-ventana')).toBe('botonera-ventana');
    expect(tabFromGuardiaSegment('botonera-monitoreo')).toBe('botonera');
    expect(tabFromGuardiaSegment('botonera-guardia')).toBe('botonera');
    expect(sectionFromAdminSegment('people-access')).toBe('peopleAccess');
    expect(sectionFromAdminSegment('personas')).toBe('peopleAccess');
    expect(sectionFromAdminSegment('equipos-acceso')).toBe('sistemas');
    expect(sectionFromAdminSegment('citaciones')).toBe('citaciones');
    expect(sectionFromAdminSegment('visitas')).toBe('visitas');
    expect(sectionFromAdminSegment('appearance')).toBe('appearance');
    expect(sectionFromAdminSegment('datos-empresa')).toBe('appearance');
    expect(sectionFromAdminSegment('accesos')).toBe('grupos');
    expect(sectionFromAdminSegment('puertas')).toBe('puertas');
    expect(sectionFromAdminSegment('roles')).toBe('rolesPermisos');
    expect(sectionFromAdminSegment('permissions')).toBe('rolesPermisos');
    expect(sectionFromAdminSegment('activity')).toBe('registro');
    expect(sectionFromAdminSegment('audit')).toBe('registro');
  });

  test('resolveHomePath según permisos', () => {
    const soloKiosk = { role: 'guardia', permissions: ['access.kiosk'] };
    expect(canAccessGuardia(soloKiosk)).toBe(true);
    expect(canAccessAdmin(soloKiosk)).toBe(false);
    expect(resolveHomePath(soloKiosk)).toBe('/guardia');

    const soloAdmin = { role: 'supervisor', permissions: ['users.view'] };
    expect(canAccessAdmin(soloAdmin)).toBe(true);
    expect(canAccessGuardia(soloAdmin)).toBe(false);
    expect(resolveHomePath(soloAdmin)).toBe('/admin');

    const ambos = {
      role: 'supervisor',
      permissions: ['users.view', 'entries.create', 'entries.view']
    };
    expect(resolveHomePath(ambos)).toBe('/');

    const empleado = {
      role: 'empleado-visitas',
      permissions: ['visitas.create', 'visitas.view.own']
    };
    expect(canAccessEmpleado(empleado)).toBe(true);
    expect(canAccessGuardia(empleado)).toBe(false);
    expect(canAccessAdmin(empleado)).toBe(false);
    expect(resolveHomePath(empleado)).toBe('/empleado');

    expect(getDefaultAdminSection(soloAdmin)).toBe('primerosPasos');

    const soloPermisos = { role: 'custom', permissions: ['settings.permissions'] };
    expect(getDefaultAdminSection(soloPermisos)).toBe('primerosPasos');

    const soloFlota = { role: 'custom', permissions: ['fleet.upload'] };
    expect(getDefaultAdminSection(soloFlota)).toBe('primerosPasos');

    expect(sectionFromAdminSegment('doors')).toBe('puertas');
    expect(adminPath('doors')).toBe('/admin/puertas');

    const soloAccesos = { role: 'custom', permissions: ['access.groups.manage'] };
    expect(getDefaultAdminSection(soloAccesos)).toBe('primerosPasos');
  });

  test('guardia, supervisor y monitoreo usan las mismas etiquetas de menú', () => {
    const perms = [
      'entries.create',
      'entries.view',
      'fleet.gps.read',
      'guard.doors.panel',
      'monitoring.doors.panel',
      'access.manual_open'
    ];
    const labelsOf = (user) => buildSidebarItems(user).map((item) => item.label);
    const guardia = labelsOf({ role: 'guardia', dashboardProfile: 'guardia', permissions: perms });
    const supervisor = labelsOf({ role: 'supervisor', dashboardProfile: 'supervisor', permissions: perms });
    const monitoreo = labelsOf({ role: 'monitoreo', dashboardProfile: 'monitoreo', permissions: perms });

    ['Puertas', 'Novedades', 'Vehículos', 'Flota'].forEach((label) => {
      expect(guardia).toContain(label);
      expect(supervisor).toContain(label);
    });
    expect(monitoreo).toEqual(expect.arrayContaining(['Puertas', 'Novedades']));
    const joined = [...guardia, ...supervisor, ...monitoreo].join(' ');
    expect(joined).not.toMatch(/Botonera|Cargar novedad|Vehículos externos/);
  });
});
