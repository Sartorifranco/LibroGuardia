import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Loader2, Save } from 'lucide-react';
import { apiFetch } from '../services/api';

const EVENT_META = [
  {
    key: 'exceptional_entry',
    label: 'Ingreso excepcional',
    hint: 'Cuando un guardia registra un ingreso con motivo excepcional.'
  },
  {
    key: 'repeated_denials',
    label: 'Accesos denegados repetidos',
    hint: 'Varios denegados del mismo DNI o puerta en una ventana corta.',
    hasThreshold: true
  },
  {
    key: 'door_relay_failure',
    label: 'Falla de controladora / relé',
    hint: 'Timeout o error al disparar SR201 o relé HTTP.'
  },
  {
    key: 'admin_sensitive',
    label: 'Cambios admin sensibles',
    hint: 'Borrado de usuario/rol, cambio de permisos (vía auditoría).'
  }
];

const DEFAULT_CONFIG = {
  enabled: false,
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    password: '',
    from: '',
    hasPassword: false
  },
  events: {
    exceptional_entry: { enabled: true, recipients: [] },
    repeated_denials: { enabled: true, recipients: [], threshold: 3, windowMinutes: 10 },
    door_relay_failure: { enabled: true, recipients: [] },
    admin_sensitive: { enabled: true, recipients: [] }
  }
};

const recipientsToText = (list = []) => (Array.isArray(list) ? list.join(', ') : '');
const textToRecipients = (value = '') => String(value)
  .split(/[,;\s]+/)
  .map((item) => item.trim())
  .filter(Boolean);

function NotificationsAdminPanel({ authToken, pendingAction, onPending, onSuccess, onError }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [recipientDrafts, setRecipientDrafts] = useState({});

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const data = await apiFetch('/admin/notifications-config', {
        token: authToken,
        allowForbidden: true
      });
      const next = { ...DEFAULT_CONFIG, ...(data.config || {}) };
      next.smtp = { ...DEFAULT_CONFIG.smtp, ...(next.smtp || {}) };
      next.events = { ...DEFAULT_CONFIG.events, ...(next.events || {}) };
      setConfig(next);
      const drafts = {};
      EVENT_META.forEach(({ key }) => {
        drafts[key] = recipientsToText(next.events?.[key]?.recipients);
      });
      setRecipientDrafts(drafts);
    } catch (err) {
      onError?.(err.message || 'No se pudo cargar notificaciones');
    } finally {
      setLoading(false);
    }
  }, [authToken, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const updateSmtp = (field, value) => {
    setConfig((prev) => ({
      ...prev,
      smtp: { ...prev.smtp, [field]: value }
    }));
  };

  const updateEvent = (key, field, value) => {
    setConfig((prev) => ({
      ...prev,
      events: {
        ...prev.events,
        [key]: {
          ...prev.events[key],
          [field]: value
        }
      }
    }));
  };

  const save = async () => {
    await onPending?.('saveNotifications', async () => {
      const events = {};
      EVENT_META.forEach(({ key }) => {
        events[key] = {
          ...(config.events[key] || {}),
          recipients: textToRecipients(recipientDrafts[key] || '')
        };
      });
      const body = {
        enabled: config.enabled,
        smtp: {
          host: config.smtp.host,
          port: Number(config.smtp.port) || 587,
          secure: Boolean(config.smtp.secure),
          user: config.smtp.user,
          from: config.smtp.from,
          // Solo enviar password si el usuario escribió uno nuevo.
          ...(config.smtp.password ? { password: config.smtp.password } : {})
        },
        events
      };
      const data = await apiFetch('/admin/notifications-config', {
        method: 'PUT',
        token: authToken,
        body
      });
      const saved = { ...DEFAULT_CONFIG, ...(data.config || {}) };
      saved.smtp = { ...DEFAULT_CONFIG.smtp, ...(saved.smtp || {}), password: '' };
      setConfig(saved);
      onSuccess?.(data.message || 'Notificaciones guardadas');
    });
  };

  if (loading) {
    return (
      <div className="activity-panel__loading">
        <Loader2 className="animate-spin" size={28} />
        <span>Cargando notificaciones…</span>
      </div>
    );
  }

  return (
    <div className="admin-sub-section">
      <h3 className="theme-section-title">
        <Bell size={18} style={{ display: 'inline', marginRight: 8 }} />
        Alertas por email
      </h3>
      <p className="theme-section-desc">
        Avisos SMTP ante eventos de seguridad. El envío es en segundo plano y no bloquea
        el molinete ni la operación de guardia si el correo falla.
      </p>

      <div className="theme-panel-nested mb-4">
        <label className="flex items-center gap-2 text-sm mb-3">
          <input
            type="checkbox"
            checked={config.enabled === true}
            onChange={(e) => setConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
          />
          Activar notificaciones
        </label>

        <h4 className="theme-section-title" style={{ fontSize: '1rem' }}>SMTP</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <input
            className="input-field"
            placeholder="Host (ej. smtp.gmail.com)"
            value={config.smtp.host || ''}
            onChange={(e) => updateSmtp('host', e.target.value)}
          />
          <input
            className="input-field"
            type="number"
            placeholder="Puerto"
            value={config.smtp.port || 587}
            onChange={(e) => updateSmtp('port', Number(e.target.value))}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.smtp.secure === true}
              onChange={(e) => updateSmtp('secure', e.target.checked)}
            />
            TLS/SSL (secure)
          </label>
          <input
            className="input-field"
            placeholder="Usuario SMTP"
            value={config.smtp.user || ''}
            onChange={(e) => updateSmtp('user', e.target.value)}
          />
          <input
            className="input-field"
            type="password"
            placeholder={config.smtp.hasPassword ? '•••••••• (dejar vacío para no cambiar)' : 'Password / app password'}
            value={config.smtp.password || ''}
            onChange={(e) => updateSmtp('password', e.target.value)}
            autoComplete="new-password"
          />
          <input
            className="input-field md:col-span-2"
            placeholder="From (ej. alertas@empresa.com)"
            value={config.smtp.from || ''}
            onChange={(e) => updateSmtp('from', e.target.value)}
          />
        </div>
      </div>

      <h4 className="theme-section-title" style={{ fontSize: '1.05rem' }}>Eventos</h4>
      <div className="theme-stack">
        {EVENT_META.map((meta) => {
          const event = config.events[meta.key] || { enabled: false, recipients: [] };
          return (
            <div key={meta.key} className="theme-panel-nested">
              <label className="flex items-center gap-2 text-sm mb-2">
                <input
                  type="checkbox"
                  checked={event.enabled !== false}
                  onChange={(e) => updateEvent(meta.key, 'enabled', e.target.checked)}
                />
                <strong>{meta.label}</strong>
              </label>
              <p className="theme-section-desc" style={{ marginTop: 0 }}>{meta.hint}</p>
              <input
                className="input-field"
                placeholder="Destinatarios (emails separados por coma)"
                value={recipientDrafts[meta.key] || ''}
                onChange={(e) => setRecipientDrafts((prev) => ({ ...prev, [meta.key]: e.target.value }))}
              />
              {meta.hasThreshold && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                  <label className="field-label">
                    Umbral (cantidad)
                    <input
                      className="input-field"
                      type="number"
                      min="2"
                      max="20"
                      value={event.threshold || 3}
                      onChange={(e) => updateEvent(meta.key, 'threshold', Number(e.target.value))}
                    />
                  </label>
                  <label className="field-label">
                    Ventana (minutos)
                    <input
                      className="input-field"
                      type="number"
                      min="1"
                      max="120"
                      value={event.windowMinutes || 10}
                      onChange={(e) => updateEvent(meta.key, 'windowMinutes', Number(e.target.value))}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 mt-4">
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={pendingAction === 'saveNotifications'}
        >
          {pendingAction === 'saveNotifications'
            ? <Loader2 size={16} className="animate-spin" />
            : <Save size={16} />}
          Guardar
        </button>
      </div>
    </div>
  );
}

export default NotificationsAdminPanel;
