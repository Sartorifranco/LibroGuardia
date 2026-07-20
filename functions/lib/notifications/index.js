/**
 * Registry de canales de notificación (mismo patrón que doorDrivers).
 * Sumar un canal = agregar archivo + registrarlo en CHANNELS.
 */

const email = require('./email');
const {
  getNotificationsConfig,
  publicNotificationsConfig,
  saveNotificationsConfig,
  EVENT_TYPES
} = require('./config');
const { checkRepeatedDenials } = require('./denialThreshold');

const CHANNELS = {
  email
};

const DEFAULT_CHANNEL = 'email';

const getChannel = (id = DEFAULT_CHANNEL) => CHANNELS[id] || CHANNELS[DEFAULT_CHANNEL];

const buildMessage = (eventType, payload = {}) => {
  const brand = 'LibroGuardia';
  switch (eventType) {
    case 'exceptional_entry':
      return {
        subject: `${brand}: ingreso excepcional`,
        text: [
          'Se registró un ingreso excepcional.',
          `Nombre: ${payload.name || '—'}`,
          `DNI: ${payload.idNumber || '—'}`,
          `Motivo: ${payload.reason || '—'}`,
          `Operador: ${payload.username || payload.userId || '—'}`,
          `EntryId: ${payload.entryId || '—'}`
        ].join('\n')
      };
    case 'repeated_denials':
      return {
        subject: `${brand}: accesos denegados repetidos`,
        text: [
          'Se detectaron varios intentos denegados en poco tiempo.',
          `DNI: ${payload.idNumber || '—'}`,
          `Puerta: ${payload.doorId || '—'}`,
          `Cantidad: ${payload.count || 0} (umbral ${payload.threshold || 3} / ${payload.windowMinutes || 10} min)`,
          `Último motivo: ${payload.reason || '—'}`
        ].join('\n')
      };
    case 'door_relay_failure':
      return {
        subject: `${brand}: falla de controladora / relé`,
        text: [
          'No se pudo abrir una puerta (timeout o error del driver).',
          `Puerta: ${payload.doorName || payload.doorId || '—'}`,
          `Driver/vía: ${payload.via || payload.driver || '—'}`,
          `Error: ${payload.error || '—'}`,
          `Operador: ${payload.username || '—'}`
        ].join('\n')
      };
    case 'admin_sensitive':
      return {
        subject: `${brand}: cambio administrativo sensible`,
        text: [
          'Acción administrativa sensible registrada.',
          `Acción: ${payload.action || '—'}`,
          `Actor: ${payload.actorUsername || payload.actorId || '—'}`,
          `Entidad: ${payload.targetType || '—'} ${payload.targetId || ''}`.trim(),
          `Detalle: ${JSON.stringify(payload.changedKeys || [])}`
        ].join('\n')
      };
    default:
      return {
        subject: `${brand}: alerta`,
        text: JSON.stringify(payload, null, 2)
      };
  }
};

/**
 * Despacha a los canales activos. Nunca lanza: fire-and-forget seguro.
 */
const notify = async (eventType, payload = {}) => {
  try {
    if (!EVENT_TYPES.includes(eventType)) {
      return { sent: false, skipped: true, reason: 'evento_desconocido' };
    }

    const config = await getNotificationsConfig();
    if (!config.enabled) {
      return { sent: false, skipped: true, reason: 'notificaciones_deshabilitadas' };
    }

    const eventCfg = config.events[eventType] || {};
    if (eventCfg.enabled === false) {
      return { sent: false, skipped: true, reason: 'evento_deshabilitado' };
    }

    const recipients = Array.isArray(eventCfg.recipients) ? eventCfg.recipients : [];
    if (!recipients.length) {
      return { sent: false, skipped: true, reason: 'sin_destinatarios' };
    }

    const message = {
      ...buildMessage(eventType, payload),
      to: recipients
    };

    const channel = getChannel('email');
    return await channel.sendNotification(message, { smtp: config.smtp });
  } catch (err) {
    console.error('[notifications] Error al notificar', eventType, err.message);
    return { sent: false, error: err.message };
  }
};

const notifySafe = (eventType, payload) => {
  Promise.resolve()
    .then(() => notify(eventType, payload))
    .catch((err) => console.error('[notifications] notifySafe', eventType, err.message));
};

/**
 * Enganche post-escritura de accessEvents (sin tocar accessControl.js).
 */
const onAccessEventLogged = async (event = {}) => {
  try {
    if (event.relayError) {
      notifySafe('door_relay_failure', {
        doorId: event.doorId,
        doorName: event.doorName,
        error: event.relayError,
        username: event.username,
        via: event.relayVia || null
      });
    }

    if (event.type !== 'denied') return;

    const config = await getNotificationsConfig();
    const denialCfg = config.events.repeated_denials || {};
    if (!config.enabled || denialCfg.enabled === false) return;

    const check = await checkRepeatedDenials({
      idNumber: event.idNumber,
      doorId: event.doorId,
      threshold: denialCfg.threshold,
      windowMinutes: denialCfg.windowMinutes
    });

    if (check.triggered) {
      notifySafe('repeated_denials', {
        ...check,
        reason: event.reason,
        name: event.name
      });
    }
  } catch (err) {
    console.error('[notifications] onAccessEventLogged', err.message);
  }
};

const SENSITIVE_ADMIN_ACTIONS = new Set([
  'user.delete',
  'role.delete',
  'permissions.change',
  'user.permissions.update'
]);

/**
 * Enganche desde auditLog para acciones administrativas sensibles.
 * Más mantenible que esparcir notify() en cada endpoint de app.js.
 */
const onAdminAuditLogged = async (entry = {}) => {
  try {
    if (!SENSITIVE_ADMIN_ACTIONS.has(entry.action)) return;
    notifySafe('admin_sensitive', {
      action: entry.action,
      actorId: entry.actorId,
      actorUsername: entry.actorUsername,
      targetType: entry.targetType,
      targetId: entry.targetId,
      changedKeys: entry.changedKeys
    });
  } catch (err) {
    console.error('[notifications] onAdminAuditLogged', err.message);
  }
};

module.exports = {
  CHANNELS,
  getChannel,
  notify,
  notifySafe,
  onAccessEventLogged,
  onAdminAuditLogged,
  buildMessage,
  SENSITIVE_ADMIN_ACTIONS,
  getNotificationsConfig,
  publicNotificationsConfig,
  saveNotificationsConfig,
  EVENT_TYPES
};
