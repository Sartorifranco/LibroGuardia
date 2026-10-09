import { DEFAULT_GPS_PROVIDER_DISPLAY_NAME } from '../../utils/gpsProviderLabel';

export const ADMIN_SECTION_META = {
  users: { title: 'Usuarios', description: 'Crear cuentas, editar roles y estado de guardias.' },
  access: { title: `GPS flota ${DEFAULT_GPS_PROVIDER_DISPLAY_NAME}`, description: 'Conexión, reglas de tránsito y geocercas del mapa en vivo.' },
  equiposAcceso: {
    title: 'Sistemas',
    description: 'Equipos del sitio, puertas y la forma anterior de instalar.'
  },
  doors: { title: 'Equipos de acceso', description: 'Puertas, lectores y estaciones en un solo lugar.' },
  peopleAccess: {
    title: 'Personas',
    description: 'Directorio único: empleados, terceros, clientes y credenciales de acceso.'
  },
  negocioAccesos: {
    title: 'Accesos',
    description: 'Grupos de puertas, horarios y feriados. También podés probar si una persona puede pasar.'
  },
  citaciones: { title: 'Autorizaciones', description: 'Citados de transporte, carga manual y listado de autorizados.' },
  nomina: { title: 'Nómina de personal', description: 'Importar, buscar y editar empleados, turnos y tipo de autorización.' },
  vehicles: { title: 'Vehículos autorizados', description: 'Precarga de patentes y carga masiva.' },
  fleet: { title: 'Flota interna', description: 'Listas de móviles y choferes.' },
  empresas: {
    title: 'Empresas del predio',
    description: 'Dominios de email para autoregistro de empleados que luego cargan visitas/autorizados.'
  },
  destinos: {
    title: 'Recorridos de visita',
    description: 'Qué puertas hay que pasar para llegar a un lugar del predio.'
  },
  visitas: {
    title: 'Aprobar visitas',
    description: 'Solicitudes de empleados que no pueden autorizar visitas por sí mismos.'
  },
  appearance: {
    title: 'Datos de la empresa',
    description: 'Nombre, logo y colores que se ven en el sistema.'
  },
  lectores: {
    title: 'Equipos de acceso',
    description: 'Puertas, lectores y estaciones en un solo lugar.'
  },
  estaciones: {
    title: 'Equipos de acceso',
    description: 'Puertas, lectores y estaciones en un solo lugar.'
  },
  permissions: { title: 'Permisos por rol', description: 'Matriz granular de capacidades del sistema.' },
  roles: { title: 'Roles', description: 'Crear, editar y eliminar roles con permisos y pantalla de inicio.' },
  activity: { title: 'Actividad', description: 'Auditoría reciente de eliminaciones y cambios administrativos.' },
  audit: { title: 'Auditoría', description: 'Trazabilidad de cambios administrativos (usuarios, roles, permisos, puertas).' },
  notifications: { title: 'Avisos por mail', description: 'A quién escribir cuando pasa algo importante.' },
  primerosPasos: { title: 'Primeros pasos', description: 'Lo que falta para dejar el predio funcionando.' },
  lugares: { title: 'Lugares', description: 'Zonas del predio que conecta cada puerta.' },
  puertas: { title: 'Puertas', description: 'Cada puerta, qué lugares conecta y cuánto queda abierta.' },
  equipos: { title: 'Equipos', description: 'La cajita que abre las puertas.' },
  sistemas: { title: 'Sistemas', description: 'Opciones para el instalador.' },
  grupos: { title: 'Grupos de acceso', description: 'Puertas y horario que comparten las mismas personas.' },
  horarios: { title: 'Horarios', description: 'Días y horas en que vale un permiso.' },
  feriados: { title: 'Feriados', description: 'Días del año en que el horario cambia.' },
  puedePasar: { title: '¿Puede pasar?', description: 'Probar si una persona entra por una puerta.' },
  rolesPermisos: { title: 'Roles y permisos', description: 'Qué puede hacer cada tipo de usuario.' },
  registro: { title: 'Registro de cambios', description: 'Quién modificó qué, y cuándo.' },
  huella: { title: 'Huella', description: 'Lectores de huella del predio.' },
  citacionesAuto: { title: 'Citaciones automáticas', description: 'Recibir citados desde la carpeta de la empresa.' }
};

export const AUTH_WEEKDAYS = [
  { code: 'Lu', label: 'Lun' },
  { code: 'Ma', label: 'Mar' },
  { code: 'Mi', label: 'Mié' },
  { code: 'Ju', label: 'Jue' },
  { code: 'Vi', label: 'Vie' },
  { code: 'Sa', label: 'Sáb' },
  { code: 'Do', label: 'Dom' }
];

export const AUTH_TYPE_LABELS = {
  citacion: 'Citación',
  visita: 'Visita',
  visit: 'Visita',
  temporal: 'Temporal',
  permanent: 'Permanente'
};

export const formatAuthSchedule = (item) => {
  const type = item.type === 'visit' ? 'visita' : item.type;
  if (type === 'permanent') {
    const days = item.daysOfWeek?.length ? item.daysOfWeek.join(', ') : 'Todos los días';
    const time = item.timeWindow?.from && item.timeWindow?.to
      ? `${item.timeWindow.from}–${item.timeWindow.to}`
      : 'Sin tope horario';
    return `${days} · ${time}`;
  }
  if (type === 'visita' || type === 'temporal') {
    if (item.endDate && item.endDate !== item.startDate) {
      return `${item.startDate} → ${item.endDate}`;
    }
    return item.startDate || '—';
  }
  return item.startDate || item.appointmentDate || '—';
};
