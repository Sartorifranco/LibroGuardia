import { buildAdminNav, canOpenAdvancedSection, legacyAdminRedirect } from './adminNav';

const labels = (user, options) => buildAdminNav(user, options).flatMap((group) => group.items.map((item) => item.label));

describe('menú de administración', () => {
  test('cada ítem aparece solo con el permiso que le corresponde', () => {
    const flota = labels({ role: 'custom', permissions: ['fleet.upload'] });
    expect(flota).toEqual(expect.arrayContaining(['Primeros pasos', 'Flota']));
    ['Usuarios', 'Puertas', 'Sistemas', 'Horarios'].forEach((label) => {
      expect(flota).not.toContain(label);
    });

    const puertas = labels({ role: 'custom', permissions: ['access.doors.manage'] });
    expect(puertas).toEqual(expect.arrayContaining(['Lugares', 'Puertas']));
    expect(puertas).not.toContain('Equipos');

    const equipos = labels({ role: 'custom', permissions: ['lectores.manage'] });
    expect(equipos).toContain('Equipos');

    const grupos = labels({ role: 'custom', permissions: ['access.groups.manage'] });
    expect(grupos).toEqual(expect.arrayContaining(['Grupos de acceso', 'Horarios', 'Feriados', '¿Puede pasar?']));

    const soloAsignar = labels({ role: 'custom', permissions: ['personas.puertas.asignar'] });
    expect(soloAsignar).toEqual(expect.arrayContaining(['Grupos de acceso', '¿Puede pasar?']));
    expect(soloAsignar).not.toContain('Horarios');
    expect(soloAsignar).not.toContain('Feriados');

    const visitas = labels({ role: 'supervisor', permissions: ['visitas.approve'] });
    expect(visitas).toContain('Autorizaciones');
    expect(visitas).not.toContain('Aprobar visitas');
  });

  test('las opciones avanzadas solo se ven para admin con el interruptor', () => {
    const admin = { role: 'admin', permissions: [] };
    expect(canOpenAdvancedSection(admin, false)).toBe(false);
    expect(canOpenAdvancedSection(admin, true)).toBe(true);
    expect(canOpenAdvancedSection({ role: 'supervisor', permissions: ['access.doors.manage'] }, true)).toBe(false);
    expect(labels(admin, { showAdvanced: false })).not.toContain('Sistemas');
    expect(labels(admin, { showAdvanced: true })).toContain('Sistemas');
    expect(labels({ role: 'supervisor', permissions: ['settings.permissions', 'access.doors.manage'] }, { showAdvanced: true })).not.toContain('Sistemas');
  });

  test('las URLs viejas redirigen a la pantalla nueva', () => {
    expect(legacyAdminRedirect('roles')).toBe('/admin/roles-permisos?tab=roles');
    expect(legacyAdminRedirect('permissions')).toBe('/admin/roles-permisos?tab=permisos');
    expect(legacyAdminRedirect('equipos-acceso')).toBe('/admin/sistemas');
    expect(legacyAdminRedirect('doors')).toBe('/admin/puertas');
    expect(legacyAdminRedirect('access')).toBe('/admin/gps');
    expect(legacyAdminRedirect('destinos')).toBe('/admin/recorridos');
    expect(legacyAdminRedirect('activity')).toBe('/admin/registro?tipo=actividad');
    expect(legacyAdminRedirect('audit')).toBe('/admin/registro?tipo=auditoria');
    expect(legacyAdminRedirect('appearance')).toBe('/admin/datos-empresa');
    expect(legacyAdminRedirect('notifications')).toBe('/admin/avisos');
    expect(legacyAdminRedirect('vehicles')).toBe('/admin/vehiculos');
    expect(legacyAdminRedirect('fleet')).toBe('/admin/flota');
    expect(legacyAdminRedirect('users')).toBeNull();
    expect(legacyAdminRedirect('primeros-pasos')).toBeNull();
  });
});
