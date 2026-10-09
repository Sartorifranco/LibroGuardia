import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { AdminLoading } from './admin/AdminUi';
import { apiFetch } from '../services/api';
import { PageHeader, EmptyState, AdvancedSection, HelpTip } from './admin-ui';
import { MAIL_PRESETS } from '../pages/Admin/NotificationsAdmin/mailPresets';

const EVENT_META = [
  {
    key: 'edge_alarm',
    label: 'Puerta forzada',
    hint: 'Cuando una puerta se abre sin permiso.'
  },
  {
    key: 'held_open',
    label: 'Abierta demasiado tiempo',
    hint: 'Cuando una puerta queda abierta más de lo normal.'
  },
  {
    key: 'exceptional_entry',
    label: 'Emergencia',
    hint: 'Cuando alguien entra con un motivo de emergencia.'
  },
  {
    key: 'duress_access',
    label: 'Coacción',
    hint: 'Cuando una persona marca que está en peligro. La puerta se abre igual.'
  },
  {
    key: 'bridge_offline',
    label: 'Equipo sin conexión',
    hint: 'Cuando un equipo de la planta deja de responder.'
  },
  {
    key: 'access_request',
    label: 'Solicitud de autorización',
    hint: 'Cuando alguien pide un ingreso. También se avisa al responsable de la empresa.'
  },
  {
    key: 'ingreso_emergencia',
    label: 'Ingreso de emergencia',
    hint: 'Cuando un guardia abre la puerta por emergencia.'
  },
  {
    key: 'admin_sensitive',
    label: 'Cambios sensibles',
    hint: 'Cuando se borra un usuario o se cambian permisos.'
  },
  {
    key: 'door_relay_failure',
    label: 'La puerta no se pudo abrir',
    hint: 'Cuando el sistema intenta abrir y no lo logra.'
  },
  {
    key: 'repeated_denials',
    label: 'Rechazos seguidos',
    hint: 'Varias veces seguida la misma persona o la misma puerta.',
    hasThreshold: true
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
  events: {}
};

EVENT_META.forEach(({ key, hasThreshold }) => {
  DEFAULT_CONFIG.events[key] = {
    enabled: true,
    recipients: [],
    ...(hasThreshold ? { threshold: 3, windowMinutes: 10 } : {})
  };
});

const looksLikeMail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

const recipientsToList = (list = []) => (Array.isArray(list) ? list.filter(looksLikeMail) : []);

function NotificationsAdminPanel({ authToken, pendingAction, onPending, onSuccess, onError }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [users, setUsers] = useState([]);
  const [looseDraft, setLooseDraft] = useState({});
  const [mailChoice, setMailChoice] = useState('otro');

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setLoadError('');
    try {
      const [data, usersData] = await Promise.all([
        apiFetch('/admin/notifications-config', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/users', { token: authToken, allowForbidden: true }).catch(() => ({ users: [] }))
      ]);
      const next = { ...DEFAULT_CONFIG, ...(data.config || {}) };
      next.smtp = { ...DEFAULT_CONFIG.smtp, ...(next.smtp || {}) };
      next.events = { ...DEFAULT_CONFIG.events, ...(next.events || {}) };
      EVENT_META.forEach(({ key }) => {
        next.events[key] = {
          ...DEFAULT_CONFIG.events[key],
          ...(next.events[key] || {}),
          recipients: recipientsToList(next.events[key]?.recipients)
        };
      });
      setConfig(next);
      setUsers(Array.isArray(usersData?.users) ? usersData.users : []);
      const host = String(next.smtp.host || '').toLowerCase();
      if (host.includes('gmail')) setMailChoice('gmail');
      else if (host.includes('office365') || host.includes('outlook')) setMailChoice('outlook');
      else setMailChoice('otro');
    } catch (err) {
      setLoadError(err.message || 'No se pudieron cargar los avisos');
      onError?.(err.message || 'No se pudieron cargar los avisos');
    } finally {
      setLoading(false);
    }
  }, [authToken, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const userMails = useMemo(() => {
    const seen = new Set();
    const list = [];
    users.forEach((user) => {
      const candidates = [user.email, user.username];
      candidates.forEach((value) => {
        const mail = String(value || '').trim().toLowerCase();
        if (!looksLikeMail(mail) || seen.has(mail)) return;
        seen.add(mail);
        list.push({ mail, label: user.nombre || user.username || mail });
      });
    });
    return list;
  }, [users]);

  const updateSmtp = (field, value) => {
    setConfig((prev) => ({
      ...prev,
      smtp: { ...prev.smtp, [field]: value }
    }));
  };

  const applyPreset = (id) => {
    const preset = MAIL_PRESETS.find((item) => item.id === id) || MAIL_PRESETS[2];
    setMailChoice(preset.id);
    setConfig((prev) => ({
      ...prev,
      smtp: {
        ...prev.smtp,
        host: preset.id === 'otro' ? prev.smtp.host : preset.host,
        port: preset.port,
        secure: preset.secure
      }
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

  const addRecipient = (key, mail) => {
    const clean = String(mail || '').trim().toLowerCase();
    if (!looksLikeMail(clean)) {
      onError?.('Ese mail no está completo. Tiene que tener un @ y un punto, por ejemplo ana@empresa.com.');
      return;
    }
    setConfig((prev) => {
      const current = recipientsToList(prev.events[key]?.recipients);
      if (current.includes(clean)) return prev;
      return {
        ...prev,
        events: {
          ...prev.events,
          [key]: { ...prev.events[key], recipients: [...current, clean] }
        }
      };
    });
    setLooseDraft((prev) => ({ ...prev, [key]: '' }));
  };

  const removeRecipient = (key, mail) => {
    setConfig((prev) => ({
      ...prev,
      events: {
        ...prev.events,
        [key]: {
          ...prev.events[key],
          recipients: recipientsToList(prev.events[key]?.recipients).filter((item) => item !== mail)
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
          recipients: recipientsToList(config.events[key]?.recipients)
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
      onSuccess?.(data.message || 'Avisos guardados');
    });
  };

  const sendTest = async (key) => {
    const to = recipientsToList(config.events[key]?.recipients)[0];
    if (!to) {
      onError?.('Elegí al menos un mail para este aviso antes de probar.');
      return;
    }
    await onPending?.(`test-${key}`, async () => {
      try {
        const data = await apiFetch('/admin/notifications-config/test', {
          method: 'POST',
          token: authToken,
          body: { to, eventKey: key }
        });
        onSuccess?.(data.message || 'Prueba enviada');
      } catch (err) {
        onError?.(err.message || 'No se pudo enviar la prueba');
      }
    });
  };

  if (loading) {
    return <AdminLoading label="Cargando avisos…" />;
  }

  if (loadError && !config.smtp.host && !Object.keys(config.events || {}).length) {
    return (
      <EmptyState
        title="No se pudieron cargar los avisos"
        text={loadError}
        actionLabel="Reintentar"
        onAction={load}
      />
    );
  }

  return (
    <div className="admin-simple admin-sub-section">
      <PageHeader
        title="Avisos por mail"
        purpose="Decidís quién se entera cuando pasa algo importante en una puerta o en el sistema."
        howTo={[
          'Elegí quién recibe cada aviso.',
          'Prendé o apagá el aviso con el interruptor.',
          'Guardá. Si hace falta, probá el envío.'
        ]}
        action={(
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
        )}
      />

      <label className="admin-simple-sentence">
        <input
          type="checkbox"
          checked={config.enabled === true}
          onChange={(e) => setConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
        />
        Enviar avisos por mail
        <HelpTip text="Si está apagado, no sale ningún mail aunque el aviso esté prendido." />
      </label>

      <h3 className="admin-block__title" style={{ margin: '1rem 0 0.65rem' }}>¿Quién recibe qué aviso?</h3>

      <div className="admin-simple-table-wrap">
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <th className="px-2 py-2 text-left">Aviso</th>
              <th className="px-2 py-2 text-left">Destinatarios</th>
              <th className="px-2 py-2 text-left">Prendido</th>
              <th className="px-2 py-2 text-left">Prueba</th>
            </tr>
          </thead>
          <tbody>
            {EVENT_META.map((meta) => {
              const event = config.events[meta.key] || { enabled: false, recipients: [] };
              return (
                <tr key={meta.key}>
                  <td className="px-2 py-3 align-top">
                    <strong>{meta.label}</strong>
                    <p className="historial-meta" style={{ margin: '0.2rem 0 0' }}>{meta.hint}</p>
                    {meta.hasThreshold ? (
                      <p className="admin-simple-sentence">
                        Avisar si alguien es rechazado
                        <input
                          aria-label="Cantidad de rechazos"
                          className="input-field"
                          type="number"
                          min="2"
                          max="20"
                          value={event.threshold || 3}
                          onChange={(e) => updateEvent(meta.key, 'threshold', Number(e.target.value))}
                        />
                        veces en
                        <input
                          aria-label="Minutos de la ventana"
                          className="input-field"
                          type="number"
                          min="1"
                          max="120"
                          value={event.windowMinutes || 10}
                          onChange={(e) => updateEvent(meta.key, 'windowMinutes', Number(e.target.value))}
                        />
                        minutos
                      </p>
                    ) : null}
                  </td>
                  <td className="px-2 py-3 align-top">
                    <RecipientPicker
                      meta={meta}
                      event={event}
                      userMails={userMails}
                      loose={looseDraft[meta.key] || ''}
                      onLoose={(value) => setLooseDraft((prev) => ({ ...prev, [meta.key]: value }))}
                      onAdd={(mail) => addRecipient(meta.key, mail)}
                      onRemove={(mail) => removeRecipient(meta.key, mail)}
                    />
                  </td>
                  <td className="px-2 py-3 align-top">
                    <label className="admin-simple-sentence">
                      <input
                        type="checkbox"
                        aria-label={`Prender ${meta.label}`}
                        checked={event.enabled !== false}
                        onChange={(e) => updateEvent(meta.key, 'enabled', e.target.checked)}
                      />
                      {event.enabled !== false ? 'Sí' : 'No'}
                    </label>
                  </td>
                  <td className="px-2 py-3 align-top">
                    <button
                      type="button"
                      className="btn btn-secondary admin-simple-touch"
                      onClick={() => sendTest(meta.key)}
                      disabled={pendingAction === `test-${meta.key}`}
                    >
                      Enviar prueba
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="admin-simple-cards" aria-label="Avisos en tarjetas">
        {EVENT_META.map((meta) => {
          const event = config.events[meta.key] || { enabled: false, recipients: [] };
          return (
            <article key={meta.key} className="admin-simple-card">
              <strong>{meta.label}</strong>
              <p className="historial-meta">{meta.hint}</p>
              <RecipientPicker
                meta={meta}
                event={event}
                userMails={userMails}
                loose={looseDraft[meta.key] || ''}
                onLoose={(value) => setLooseDraft((prev) => ({ ...prev, [meta.key]: value }))}
                onAdd={(mail) => addRecipient(meta.key, mail)}
                onRemove={(mail) => removeRecipient(meta.key, mail)}
              />
              <label className="admin-simple-sentence">
                <input
                  type="checkbox"
                  aria-label={`Prender ${meta.label}`}
                  checked={event.enabled !== false}
                  onChange={(e) => updateEvent(meta.key, 'enabled', e.target.checked)}
                />
                Aviso prendido
              </label>
              <button type="button" className="btn btn-secondary" onClick={() => sendTest(meta.key)}>
                Enviar prueba
              </button>
            </article>
          );
        })}
      </div>

      <AdvancedSection>
        <h4 className="admin-block__title">¿Qué correo usan?</h4>
        <div className="admin-simple-choice" role="group" aria-label="Tipo de correo">
          {MAIL_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`admin-simple-choice__card${mailChoice === preset.id ? ' is-selected' : ''}`}
              onClick={() => applyPreset(preset.id)}
            >
              <strong>{preset.label}</strong>
            </button>
          ))}
        </div>
        <p className="historial-meta">
          Gmail y Outlook completan el servidor, el puerto y la seguridad. En Otro los cargás vos.
        </p>
        <label className="field-label">
          Servidor de correo (SMTP)
          <HelpTip text="Es la dirección que te da quien administra el correo. En Gmail suele ser smtp.gmail.com." />
          <input
            className="input-field"
            aria-label="Servidor SMTP"
            value={config.smtp.host || ''}
            onChange={(e) => updateSmtp('host', e.target.value)}
          />
        </label>
        <label className="field-label">
          Puerto
          <input
            className="input-field"
            aria-label="Puerto"
            type="number"
            value={config.smtp.port || 587}
            onChange={(e) => updateSmtp('port', Number(e.target.value))}
          />
        </label>
        <label className="admin-simple-sentence">
          <input
            type="checkbox"
            aria-label="TLS"
            checked={config.smtp.secure === true}
            onChange={(e) => updateSmtp('secure', e.target.checked)}
          />
          TLS (conexión cifrada directa, puerto 465)
        </label>
        <label className="field-label">
          Usuario
          <input
            className="input-field"
            aria-label="Usuario del correo"
            value={config.smtp.user || ''}
            onChange={(e) => updateSmtp('user', e.target.value)}
          />
        </label>
        <label className="field-label">
          Contraseña del correo
          <input
            className="input-field"
            type="password"
            aria-label="Contraseña del correo"
            placeholder={config.smtp.hasPassword ? 'Ya hay una guardada. Dejala vacía si no cambia.' : 'Contraseña'}
            value={config.smtp.password || ''}
            onChange={(e) => updateSmtp('password', e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="field-label">
          Mail que aparece como remitente
          <input
            className="input-field"
            aria-label="Remitente"
            placeholder="avisos@empresa.com"
            value={config.smtp.from || ''}
            onChange={(e) => updateSmtp('from', e.target.value)}
          />
        </label>
      </AdvancedSection>
    </div>
  );
}

function RecipientPicker({ meta, event, userMails, loose, onLoose, onAdd, onRemove }) {
  const recipients = recipientsToList(event.recipients);
  return (
    <div>
      {recipients.length === 0 ? (
        <p className="historial-meta">Nadie todavía.</p>
      ) : (
        <ul className="historial-meta" style={{ margin: 0, paddingLeft: '1rem' }}>
          {recipients.map((mail) => (
            <li key={mail}>
              {mail}
              {' '}
              <button type="button" className="btn btn-secondary-small" onClick={() => onRemove(mail)}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
      {userMails.length > 0 ? (
        <label className="field-label" style={{ marginTop: '0.4rem' }}>
          Usuario del sistema
          <select
            className="input-field"
            aria-label={`Usuario para ${meta.label}`}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) onAdd(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="">Elegir…</option>
            {userMails.map((user) => (
              <option key={user.mail} value={user.mail}>{user.label} ({user.mail})</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field-label">
        Mail suelto
        <span className="admin-simple-sentence">
          <input
            className="input-field"
            aria-label={`Mail suelto para ${meta.label}`}
            value={loose}
            placeholder="ana@empresa.com"
            onChange={(e) => onLoose(e.target.value)}
          />
          <button type="button" className="btn btn-secondary admin-simple-touch" onClick={() => onAdd(loose)}>
            Agregar
          </button>
        </span>
      </label>
    </div>
  );
}

export default NotificationsAdminPanel;
