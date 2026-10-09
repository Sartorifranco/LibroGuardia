export const ADMIN_SECTION_META = {
  users: { title: 'Usuarios del sistema', description: 'Quién entra, qué hace y cuándo ingresó por última vez.' },
  access: { title: 'GPS de vehículos', description: 'Mapa del portón y de la planta, y cuándo se avisa al guardia.' },
  equiposAcceso: {
    title: 'Sistemas',
    description: 'Equipos del sitio, puertas y la forma anterior de instalar.'
  },
  doors: { title: 'Equipos de acceso', description: 'Puertas, lectores y estaciones en un solo lugar.' },
  peopleAccess: {
    title: 'Personas',
    description: 'Ficha de cada persona: datos, credenciales, accesos y los últimos pasos.'
  },
  negocioAccesos: {
    title: 'Accesos',
    description: 'Grupos de puertas, horarios y feriados. También podés probar si una persona puede pasar.'
  },
  citaciones: { title: 'Autorizaciones', description: 'Citados de transporte, carga manual y listado de autorizados.' },
  nomina: { title: 'Importar nómina', description: 'Cargá quiénes trabajan acá, revisá altas y bajas, y confirmá.' },
  vehicles: { title: 'Vehículos', description: 'Patentes que pueden entrar, con empresa y conductor.' },
  fleet: { title: 'Flota interna', description: 'Móviles y choferes de la empresa.' },
  empresas: {
    title: 'Empresas y responsables',
    description: 'Las empresas del predio y los mails con los que su gente pide visitas.'
  },
  destinos: {
    title: 'Destinos',
    description: 'Lugares del predio con la secuencia de puertas necesarias para llegar.'
  },
  visitas: {
    title: 'Aprobar visitas',
    description: 'Solicitudes de empleados que no pueden autorizar visitas por sí mismos.'
  },
  appearance: {
    title: 'Datos de la empresa',
    description: 'El nombre que se ve y los colores de esta instalación.'
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
  activity: { title: 'Registro de cambios', description: 'Resumen de altas, cambios y bajas.' },
  audit: { title: 'Registro de cambios', description: 'Quién cambió qué, y qué quedó distinto.' },
  notifications: { title: 'Avisos por mail', description: 'Quién recibe cada aviso y cómo se envía el correo.' },
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
