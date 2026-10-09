import React, { useEffect, useMemo, useState } from 'react';
import { useGuardAlarms } from '../context/GuardAlarmsContext';
import { useAuth } from '../context/AuthContext';
import { useRuntime } from '../context/RuntimeContext';
import { apiFetch } from '../services/api';
import { guideFor } from '../utils/alarmGuide';
import { hasPermission } from '../utils/permissions';

const TYPE_OPTIONS = [
  { id: '', label: 'Todos los tipos' },
  { id: 'door_forced', label: 'Puerta forzada' },
  { id: 'held_open', label: 'Abierta demasiado tiempo' },
  { id: 'emergency', label: 'Emergencia' },
  { id: 'duress', label: 'Coacción' },
  { id: 'tailgate', label: 'Posible colado' },
  { id: 'interlock_violation', label: 'Estanco' },
  { id: 'device_offline', label: 'Equipo sin conexión' },
  { id: 'lock_fault', label: 'Falla de cerradura' }
];

function isDone(alarm) {
  const status = String(alarm?.status || '').toLowerCase();
  return alarm?.acked === true || status === 'acked' || status === 'closed' || status === 'cerrada';
}

function doorKey(alarm) {
  return alarm?.meta?.doorId || alarm?.doorId || '';
}

function doorLabel(alarm) {
  return alarm?.doorName || alarm?.meta?.doorName || doorKey(alarm) || 'Sitio';
}

function GuardAlarmsPanel({ compact = false }) {
  const { alarms, loading, error, acknowledge } = useGuardAlarms();
  const { authToken, currentUser } = useAuth();
  const { mode } = useRuntime();
  const canAck = hasPermission(currentUser, 'alarmas.reconocer') || mode === 'lan';
  const [status, setStatus] = useState('open');
  const [type, setType] = useState('');
  const [doorId, setDoorId] = useState('');
  const [extra, setExtra] = useState(null);
  const [extraLoading, setExtraLoading] = useState(false);
  const [extraError, setExtraError] = useState('');
  const [ackingId, setAckingId] = useState(null);
  const [closeMode, setCloseMode] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const filtered = !compact && (status !== 'open' || Boolean(type) || Boolean(doorId));

  useEffect(() => {
    if (!filtered || !authToken) {
      setExtra(null);
      setExtraError('');
      return undefined;
    }
    let cancelled = false;
    setExtraLoading(true);
    const query = new URLSearchParams({ status: status || 'open', limit: '50' });
    if (type) query.set('type', type);
    if (doorId) query.set('doorId', doorId);
    apiFetch(`/guard/alarms?${query.toString()}`, {
      token: authToken,
      allowForbidden: true,
      dedupe: false
    }).then((data) => {
      if (cancelled) return;
      setExtra(Array.isArray(data?.alerts) ? data.alerts : []);
      setExtraError('');
    }).catch((err) => {
      if (cancelled || err?.isForbidden) return;
      setExtraError(err.message || 'No se pudieron cargar las alarmas');
    }).finally(() => {
      if (!cancelled) setExtraLoading(false);
    });
    return () => { cancelled = true; };
  }, [filtered, status, type, doorId, authToken]);

  const shown = filtered ? (extra || []) : alarms;
  const busy = filtered ? extraLoading : loading;
  const visibleError = filtered ? extraError : error;

  const doorOptions = useMemo(() => {
    const map = new Map();
    [...alarms, ...(extra || [])].forEach((alarm) => {
      const id = doorKey(alarm);
      if (!id || map.has(id)) return;
      map.set(id, doorLabel(alarm));
    });
    return [...map.entries()];
  }, [alarms, extra]);

  const startAck = (id, closing) => {
    setAckingId(id);
    setCloseMode(Boolean(closing));
    setNote('');
    setFormError('');
  };

  const submitAck = async (event) => {
    event.preventDefault();
    if (!ackingId || note.trim().length < 3 || saving) return;
    setSaving(true);
    setFormError('');
    try {
      await acknowledge(ackingId, note, { close: closeMode });
      setExtra((prev) => (prev ? prev.filter((item) => item.id !== ackingId) : prev));
      setAckingId(null);
      setNote('');
    } catch (err) {
      setFormError(err.message || 'No se pudo reconocer la alarma');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`alarm-panel${compact ? ' alarm-panel--compact' : ''}`} aria-label="Alarmas">
      <h3>Alarmas</h3>
      {!compact && (
        <div className="alarm-panel__filters">
          <label>
            Estado
            <select aria-label="Estado" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Abiertas</option>
              <option value="recent">Recientes</option>
              <option value="closed">Cerradas</option>
            </select>
          </label>
          <label>
            Tipo
            <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPE_OPTIONS.map((option) => (
                <option key={option.id || 'all'} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            Puerta
            <select aria-label="Puerta" value={doorId} onChange={(e) => setDoorId(e.target.value)}>
              <option value="">Todas</option>
              {doorOptions.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {busy && !shown.length ? <p>Cargando alarmas…</p> : null}
      {visibleError ? <p className="alarm-panel__error" role="alert">{visibleError}</p> : null}
      {!busy && !shown.length ? (
        <p>
          {status === 'closed'
            ? 'No hay alarmas cerradas.'
            : status === 'recent'
              ? 'No hay alarmas recientes.'
              : 'No hay alarmas abiertas.'}
        </p>
      ) : null}
      <div className="alarm-panel__list">
        {shown.map((alarm) => {
          const guide = guideFor(alarm);
          const where = doorLabel(alarm);
          const done = isDone(alarm);
          return (
            <article
              key={alarm.id}
              className={`alarm-card${guide.critical && !done ? ' alarm-card--critical' : ''}`}
            >
              <h4>{guide.label}</h4>
              {where ? <p className="alarm-card__where">{where}</p> : null}
              <p className="alarm-card__kicker">Qué hacer</p>
              <p className="alarm-card__action">{guide.action}</p>
              {done ? <p className="alarm-card__where">{alarm.status === 'closed' ? 'Cerrada' : 'Reconocida'}</p> : null}
              {!done && canAck && ackingId === alarm.id ? (
                <form className="alarm-card__form" onSubmit={submitAck}>
                  <label htmlFor={`ack-note-${alarm.id}`}>
                    Nota (obligatoria)
                    <textarea
                      id={`ack-note-${alarm.id}`}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      maxLength={500}
                      aria-label="Nota para reconocer la alarma"
                    />
                  </label>
                  <p className="alarm-card__hint">Escribí al menos 3 caracteres.</p>
                  {formError ? <p className="alarm-panel__error" role="alert">{formError}</p> : null}
                  <div className="alarm-card__actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setAckingId(null)}
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={saving || note.trim().length < 3}
                    >
                      {saving ? 'Guardando…' : (closeMode ? 'Cerrar' : 'Reconocer')}
                    </button>
                  </div>
                </form>
              ) : null}
              {!done && canAck && ackingId !== alarm.id ? (
                <div className="alarm-card__actions">
                  <button
                    type="button"
                    className="btn btn-primary alarm-card__ack"
                    onClick={() => startAck(alarm.id, false)}
                  >
                    Reconocer
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary alarm-card__ack"
                    onClick={() => startAck(alarm.id, true)}
                  >
                    Cerrar
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default GuardAlarmsPanel;
