export const ADMIN_SECTION_META = {
  users: { title: 'Usuarios', description: 'Crear cuentas, editar roles y estado de guardias.' },
  access: { title: 'GPS flota UBIKA', description: 'Monitoreo de móviles en portón y registro automático.' },
  doors: { title: 'Puertas y acceso', description: 'SR201, multi-puerta, autenticación y estancos en un solo lugar.' },
  citaciones: { title: 'Autorizaciones', description: 'Citados de transporte, carga manual y listado de autorizados.' },
  nomina: { title: 'Nómina de personal', description: 'Base de empleados, turnos y tipos de autorización.' },
  vehicles: { title: 'Vehículos autorizados', description: 'Precarga de patentes y carga masiva.' },
  fleet: { title: 'Flota interna', description: 'Listas de móviles y choferes.' },
  permissions: { title: 'Permisos por rol', description: 'Matriz granular de capacidades del sistema.' },
  roles: { title: 'Roles', description: 'Crear, editar y eliminar roles con permisos y pantalla de inicio.' },
  activity: { title: 'Actividad', description: 'Auditoría reciente de eliminaciones y cambios administrativos.' },
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
