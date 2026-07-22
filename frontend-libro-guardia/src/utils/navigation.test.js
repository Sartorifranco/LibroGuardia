import {
  adminPath,
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
    expect(guardiaPath('vehiculosAutorizados')).toBe('/guardia/vehiculos-autorizados');
    expect(adminPath('users')).toBe('/admin/users');
    expect(adminPath('peopleAccess')).toBe('/admin/people-access');
  });

  test('segmentos se mapean de vuelta a tabs/secciones', () => {
    expect(tabFromGuardiaSegment('vehiculos-autorizados')).toBe('vehiculosAutorizados');
    expect(tabFromGuardiaSegment('historial')).toBe('historial');
    expect(sectionFromAdminSegment('people-access')).toBe('peopleAccess');
    expect(sectionFromAdminSegment('citaciones')).toBe('citaciones');
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

    expect(getDefaultAdminSection(soloAdmin)).toBe('users');

    // Solo permisos (sin users.view): primera visible del grupo Personas = permissions
    const soloPermisos = { role: 'custom', permissions: ['settings.permissions'] };
    expect(getDefaultAdminSection(soloPermisos)).toBe('permissions');

    // Solo flota: no cae en activity viejo; va a fleet (Datos maestros)
    const soloFlota = { role: 'custom', permissions: ['fleet.upload'] };
    expect(getDefaultAdminSection(soloFlota)).toBe('fleet');

    // Deep-link: segmento válido no depende del default
    expect(sectionFromAdminSegment('doors')).toBe('doors');
    expect(adminPath('doors')).toBe('/admin/doors');
  });
});
