/**
 * Etiquetas legibles para auditoría / actividad (espejo de functions/lib/auditLabels.js).
 */

export const ACTION_LABELS = {
  'user.create': 'Creó un usuario',
  'user.update': 'Modificó un usuario',
  'user.delete': 'Eliminó un usuario',
  'user.permissions.update': 'Cambió permisos de un usuario',
  'role.create': 'Creó un rol',
  'role.update': 'Modificó un rol',
  'role.delete': 'Eliminó un rol',
  'permissions.change': 'Cambió permisos del sistema / rol',
  'door.config.update': 'Actualizó la configuración de puertas',
  'empresa.create': 'Creó una empresa',
  'empresa.update': 'Modificó una empresa',
  'empresa.delete': 'Eliminó una empresa',
  'destino.create': 'Creó un destino',
  'destino.update': 'Modificó un destino',
  'destino.delete': 'Eliminó un destino',
  'lector.create': 'Alta de lector físico',
  'lector.update': 'Modificó un lector',
  'lector.delete': 'Eliminó un lector',
  'estacion.create': 'Creó una estación',
  'estacion.update': 'Modificó una estación',
  'estacion.delete': 'Eliminó una estación',
  'authorization.delete': 'Desactivó una autorización',
  'vehicle.delete': 'Eliminó un vehículo autorizado',
  'visita.approve': 'Aprobó una solicitud de visita',
  'visita.reject': 'Rechazó una solicitud de visita',
  'visita.create': 'Registró una visita',
  'appearance.update': 'Actualizó la apariencia del sistema'
};

export const TARGET_TYPE_LABELS = {
  user: 'Usuario',
  role: 'Rol',
  door: 'Puerta',
  doors: 'Puertas',
  empresa: 'Empresa',
  destino: 'Destino',
  lector: 'Lector',
  estacion: 'Estación',
  authorization: 'Autorización',
  vehicle: 'Vehículo',
  visita: 'Visita',
  appearance: 'Apariencia',
  permissions: 'Permisos'
};

export const FIELD_LABELS = {
  username: 'Usuario',
  role: 'Rol',
  active: 'Activo',
  nombre: 'Nombre',
  name: 'Nombre',
  email: 'Email',
  empresaId: 'Empresa',
  permissions: 'Permisos',
  mustChangePassword: 'Debe cambiar contraseña',
  dominiosPermitidos: 'Dominios permitidos',
  activa: 'Activa',
  doorIds: 'Puertas',
  estado: 'Estado',
  primaryColor: 'Color principal',
  primaryColorHover: 'Color al pasar el mouse',
  backgroundColor: 'Color de fondo',
  appTitle: 'Título de la app',
  companyName: 'Nombre de la empresa'
};

export const formatActionLabel = (action) =>
  ACTION_LABELS[action] || String(action || 'Acción').replace(/\./g, ' · ');

/** Nombre legible a partir de before/after del log (sin IDs técnicos). */
export const resolveTargetName = (item = {}) => {
  const after = item.after && typeof item.after === 'object' ? item.after : {};
  const before = item.before && typeof item.before === 'object' ? item.before : {};
  const pick = (...keys) => {
    for (const key of keys) {
      const v = after[key] ?? before[key];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  };

  switch (item.targetType) {
    case 'user':
      return pick('nombre', 'name', 'username', 'email');
    case 'role':
      return pick('label', 'nombre', 'name') || (item.targetId && !/^[a-z0-9_-]{16,}$/i.test(item.targetId) ? item.targetId : '');
    case 'empresa':
    case 'destino':
    case 'estacion':
    case 'lector':
      return pick('nombre', 'name', 'label');
    case 'visita':
      return pick('nombreVisitante', 'nombre', 'name', 'dniVisitante');
    case 'vehicle':
    case 'authorization':
      return pick('name', 'nombre', 'plate', 'patente', 'idNumber', 'dni');
    case 'appearance':
    case 'permissions':
    case 'doors':
      return '';
    default:
      return pick('nombre', 'name', 'label', 'username', 'title');
  }
};

/**
 * “Sobre qué” en lenguaje humano.
 * Ej: "Usuario Juan Pérez" — nunca "user · abc123..." si hay nombre.
 */
export const formatTargetLabel = (targetTypeOrItem, targetIdMaybe) => {
  const item = typeof targetTypeOrItem === 'object' && targetTypeOrItem
    ? targetTypeOrItem
    : { targetType: targetTypeOrItem, targetId: targetIdMaybe };

  const typeLabel = TARGET_TYPE_LABELS[item.targetType] || item.targetType || 'Elemento';
  if (item.targetType === 'appearance') return 'Configuración de apariencia';
  if (item.targetType === 'permissions') return 'Permisos del sistema';
  if (item.targetType === 'doors' || item.action === 'door.config.update') {
    return 'Configuración de puertas';
  }

  const humanName = resolveTargetName(item);
  if (humanName) return `${typeLabel} “${humanName}”`;

  // Si el id parece un nombre legible (username/email/slug corto), úsalo.
  const id = String(item.targetId || '').trim();
  if (id && id !== 'system' && !/^[a-f0-9]{20,}$/i.test(id) && id.length <= 48) {
    return `${typeLabel} “${id}”`;
  }

  return typeLabel;
};

const formatFieldValue = (value) => {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (Array.isArray(value)) {
    if (!value.length) return '(vacío)';
    if (value.every((v) => typeof v !== 'object')) return value.join(', ');
    return `${value.length} ítem(s)`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

export const buildReadableChanges = (before = null, after = null, changedKeys = null) => {
  const keys = Array.isArray(changedKeys) && changedKeys.length
    ? changedKeys.filter((k) => k !== '*')
    : [...new Set([
      ...Object.keys(before && typeof before === 'object' && !Array.isArray(before) ? before : {}),
      ...Object.keys(after && typeof after === 'object' && !Array.isArray(after) ? after : {})
    ])];

  if (!keys.length) {
    if (before == null && after != null) {
      return [{ field: '*', label: 'Alta', from: '—', to: 'Registro creado' }];
    }
    if (before != null && after == null) {
      return [{ field: '*', label: 'Baja', from: 'Registro existente', to: 'Eliminado' }];
    }
    return [];
  }

  return keys.map((key) => ({
    field: key,
    label: FIELD_LABELS[key] || key,
    from: formatFieldValue(before?.[key]),
    to: formatFieldValue(after?.[key])
  }));
};

export const buildAuditSummary = (item = {}) => {
  const who = item.actorUsername || item.actorId || 'Alguien';
  const what = formatActionLabel(item.action);
  const target = formatTargetLabel(item);
  if (item.summary) return item.summary;
  return `${who}: ${what} — ${target}`;
};
