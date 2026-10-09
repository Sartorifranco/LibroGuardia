import {
  Building2,
  CalendarClock,
  CalendarOff,
  Car,
  ClipboardList,
  Cpu,
  DoorOpen,
  Fingerprint,
  KeyRound,
  ListChecks,
  Mail,
  MapPinned,
  Palette,
  Route,
  Satellite,
  ScrollText,
  Settings,
  ShieldCheck,
  Truck,
  UserRound,
  Users,
  Clock3,
  HelpCircle,
  FolderInput,
  Wallet
} from 'lucide-react';
import { canAccessAdmin, canAccessGuardia, hasPermission } from './permissions';
import { guardiaPath } from './navigation';

const canPeople = (user) =>
  hasPermission(user, 'access.doors.manage')
  || hasPermission(user, 'access.control')
  || hasPermission(user, 'master.nomina.write');

const canDoors = (user) =>
  hasPermission(user, 'access.doors.manage') || hasPermission(user, 'access.control');

const canGroups = (user) =>
  hasPermission(user, 'access.groups.manage') || hasPermission(user, 'personas.puertas.asignar');

const canRegistro = (user) =>
  hasPermission(user, 'users.view')
  || hasPermission(user, 'roles.view')
  || hasPermission(user, 'settings.permissions')
  || hasPermission(user, 'audit.view');

const canHuella = (user) =>
  hasPermission(user, 'access.doors.manage')
  || hasPermission(user, 'access.control')
  || hasPermission(user, 'master.nomina.write')
  || hasPermission(user, 'lectores.manage');

const canAutorizaciones = (user) =>
  hasPermission(user, 'autorizaciones.solicitar')
  || hasPermission(user, 'autorizaciones.aprobar')
  || hasPermission(user, 'autorizaciones.aprobar_todas')
  || hasPermission(user, 'master.citaciones.write');

/** El interruptor y la pantalla Sistemas solo existen para el rol admin. */
export const canOpenAdvancedSection = (user, showAdvanced = false) =>
  user?.role === 'admin' && showAdvanced === true;

/**
 * Menú del panel. `match` oculta lo que el usuario no puede ver.
 * `advanced: true` además exige el interruptor de opciones avanzadas.
 */
export const ADMIN_NAV_GROUPS = [
  {
    id: 'inicio',
    label: 'Inicio',
    items: [
      {
        id: 'primerosPasos',
        label: 'Primeros pasos',
        description: 'Lo que falta para dejar el predio funcionando.',
        icon: ListChecks,
        match: (user) => canAccessAdmin(user)
      }
    ]
  },
  {
    id: 'personas',
    label: 'Personas',
    items: [
      {
        id: 'peopleAccess',
        label: 'Personas',
        description: 'Quienes entran: empleados, visitas y credenciales.',
        icon: Users,
        match: canPeople
      },
      {
        id: 'nomina',
        label: 'Importar nómina',
        description: 'Traer el listado de personal de una vez.',
        icon: ClipboardList,
        match: (user) => hasPermission(user, 'master.nomina.write')
      },
      {
        id: 'empresas',
        label: 'Empresas y responsables',
        description: 'Empresas del predio y quién responde por cada una.',
        icon: Building2,
        match: (user) => hasPermission(user, 'empresas.manage')
      },
      {
        id: 'vehicles',
        label: 'Vehículos',
        description: 'Patentes que pueden entrar.',
        icon: Car,
        match: (user) => hasPermission(user, 'master.vehicles.write')
      },
      {
        id: 'fleet',
        label: 'Flota',
        description: 'Móviles y choferes de la empresa.',
        icon: Truck,
        match: (user) => hasPermission(user, 'fleet.upload')
      }
    ]
  },
  {
    id: 'accesos',
    label: 'Accesos',
    items: [
      {
        id: 'grupos',
        label: 'Grupos de acceso',
        description: 'Un grupo junta puertas y un horario.',
        icon: ShieldCheck,
        match: canGroups
      },
      {
        id: 'horarios',
        label: 'Horarios',
        description: 'Días y horas en que vale un permiso.',
        icon: Clock3,
        match: (user) => hasPermission(user, 'access.groups.manage')
      },
      {
        id: 'feriados',
        label: 'Feriados',
        description: 'Días del año en que el horario cambia.',
        icon: CalendarOff,
        match: (user) => hasPermission(user, 'access.groups.manage')
      },
      {
        id: 'puedePasar',
        label: '¿Puede pasar?',
        description: 'Probar si una persona entra por una puerta.',
        icon: HelpCircle,
        match: canGroups
      },
      {
        id: 'destinos',
        label: 'Recorridos de visita',
        description: 'Qué puertas hay que pasar para llegar a un lugar.',
        icon: Route,
        match: (user) => hasPermission(user, 'destinos.manage')
      },
      {
        id: 'autorizaciones',
        label: 'Autorizaciones',
        description: 'Pedidos de ingreso y visitas que faltan confirmar.',
        icon: CalendarClock,
        match: (user) => canAutorizaciones(user) || hasPermission(user, 'visitas.approve'),
        href: (user) => {
          if (hasPermission(user, 'visitas.approve')) return null;
          return canAccessGuardia(user) ? guardiaPath('autorizaciones') : null;
        },
        fallbackSection: (user) => (hasPermission(user, 'visitas.approve') ? 'visitas' : 'citaciones')
      }
    ]
  },
  {
    id: 'puertas',
    label: 'Puertas y equipos',
    items: [
      {
        id: 'lugares',
        label: 'Lugares',
        description: 'Zonas del predio, como Oficinas o Tesorería.',
        icon: MapPinned,
        match: canDoors
      },
      {
        id: 'puertas',
        label: 'Puertas',
        description: 'Cada puerta, qué lugares conecta y cuánto queda abierta.',
        icon: DoorOpen,
        match: canDoors
      },
      {
        id: 'equipos',
        label: 'Equipos',
        description: 'La cajita que abre las puertas.',
        icon: Cpu,
        match: (user) => hasPermission(user, 'lectores.manage')
      }
    ]
  },
  {
    id: 'usuarios',
    label: 'Usuarios del sistema',
    items: [
      {
        id: 'users',
        label: 'Usuarios',
        description: 'Cuentas de guardias, responsables y supervisores.',
        icon: KeyRound,
        match: (user) => hasPermission(user, 'users.view')
      },
      {
        id: 'rolesPermisos',
        label: 'Roles y permisos',
        description: 'Qué puede hacer cada tipo de usuario.',
        icon: UserRound,
        match: (user) =>
          hasPermission(user, 'roles.view')
          || hasPermission(user, 'roles.manage')
          || hasPermission(user, 'settings.permissions')
      }
    ]
  },
  {
    id: 'avisos',
    label: 'Avisos',
    items: [
      {
        id: 'notifications',
        label: 'Avisos por mail',
        description: 'A quién escribir cuando pasa algo importante.',
        icon: Mail,
        match: (user) => hasPermission(user, 'notifications.config')
      }
    ]
  },
  {
    id: 'integraciones',
    label: 'Integraciones',
    items: [
      {
        id: 'access',
        label: 'GPS de vehículos',
        description: 'Dónde están los móviles de la flota.',
        icon: Satellite,
        match: (user) => hasPermission(user, 'access.control')
      },
      {
        id: 'huella',
        label: 'Huella (BioStar)',
        description: 'Lectores de huella del predio.',
        icon: Fingerprint,
        match: canHuella
      },
      {
        id: 'citacionesAuto',
        label: 'Citaciones automáticas',
        description: 'Recibir citados desde la carpeta de la empresa.',
        icon: FolderInput,
        match: (user) => hasPermission(user, 'master.citaciones.write')
      }
    ]
  },
  {
    id: 'registro',
    label: 'Registro',
    items: [
      {
        id: 'registro',
        label: 'Registro de cambios',
        description: 'Quién modificó qué, y cuándo.',
        icon: ScrollText,
        match: canRegistro
      },
      {
        id: 'consumo',
        label: 'Consumo',
        description: 'Cuánto gasta el sistema por mes y aviso si se pasa del tope.',
        icon: Wallet,
        match: (user) => hasPermission(user, 'consumo.ver') || hasPermission(user, 'settings.permissions')
      }
    ]
  },
  {
    id: 'empresa',
    label: 'Empresa',
    items: [
      {
        id: 'appearance',
        label: 'Datos de la empresa',
        description: 'Nombre, logo y colores que se ven en el sistema.',
        icon: Palette,
        match: (user) => hasPermission(user, 'settings.permissions')
      }
    ]
  },
  {
    id: 'avanzado',
    label: 'Opciones avanzadas',
    advanced: true,
    items: [
      {
        id: 'sistemas',
        label: 'Sistemas',
        description: 'Forma anterior de instalar, marcas y paquetes.',
        icon: Settings,
        advanced: true,
        match: (user) => user?.role === 'admin'
      }
    ]
  }
];

export function buildAdminNav(user, { showAdvanced = false } = {}) {
  if (!user) return [];
  const advancedOn = canOpenAdvancedSection(user, showAdvanced);
  return ADMIN_NAV_GROUPS.map((group) => {
    if (group.advanced && !advancedOn) return { ...group, items: [] };
    return {
      ...group,
      items: group.items.filter((item) => {
        if (item.advanced && !advancedOn) return false;
        return item.match(user);
      }).map((item) => ({
        ...item,
        href: typeof item.href === 'function' ? item.href(user) : (item.href || null),
        fallbackSection: typeof item.fallbackSection === 'function'
          ? item.fallbackSection(user)
          : (item.fallbackSection || null)
      }))
    };
  }).filter((group) => group.items.length > 0);
}

/** Segmento viejo → URL canónica. null si ya es la URL nueva. */
const LEGACY_ADMIN_REDIRECT = {
  roles: '/admin/roles-permisos?tab=roles',
  permissions: '/admin/roles-permisos?tab=permisos',
  activity: '/admin/registro?tipo=actividad',
  audit: '/admin/registro?tipo=auditoria',
  appearance: '/admin/datos-empresa',
  destinos: '/admin/recorridos',
  accesos: '/admin/grupos',
  'equipos-acceso': '/admin/sistemas',
  doors: '/admin/puertas',
  lectores: '/admin/sistemas',
  estaciones: '/admin/sistemas',
  access: '/admin/gps',
  notifications: '/admin/avisos',
  vehicles: '/admin/vehiculos',
  fleet: '/admin/flota',
  'people-access': '/admin/personas'
};

export function legacyAdminRedirect(segment) {
  return LEGACY_ADMIN_REDIRECT[String(segment || '')] || null;
}

/** Pestaña o filtro que trae una URL vieja, antes de redirigir. */
export function adminSegmentQuery(segment) {
  if (segment === 'roles') return { tab: 'roles' };
  if (segment === 'permissions') return { tab: 'permisos' };
  if (segment === 'activity') return { tipo: 'actividad' };
  if (segment === 'audit') return { tipo: 'auditoria' };
  return {};
}
