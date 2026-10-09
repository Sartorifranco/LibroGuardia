import React, { useState } from 'react';
import { useGuardAlarms } from '../context/GuardAlarmsContext';
import { guideFor } from '../utils/alarmGuide';

function GuardAlarmsPanel({ compact = false }) {
  const { alarms, loading, error, acknowledge } = useGuardAlarms();
  const [ackingId, setAckingId] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const startAck = (id) => {
    setAckingId(id);
    setNote('');
    setFormError('');
  };

  const submitAck = async (event) => {
    event.preventDefault();
    if (!ackingId || note.trim().length < 3 || saving) return;
    setSaving(true);
    setFormError('');
    try {
      await acknowledge(ackingId, note);
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
      {loading && !alarms.length ? <p>Cargando alarmas…</p> : null}
      {error ? <p className="alarm-panel__error" role="alert">{error}</p> : null}
      {!loading && !alarms.length ? <p>No hay alarmas abiertas.</p> : null}
      <div className="alarm-panel__list">
        {alarms.map((alarm) => {
          const guide = guideFor(alarm);
          const where = alarm.doorName || alarm.message || '';
          return (
            <article
              key={alarm.id}
              className={`alarm-card${guide.critical ? ' alarm-card--critical' : ''}`}
            >
              <h4>{guide.label}</h4>
              {where && where !== guide.action ? <p className="alarm-card__where">{where}</p> : null}
              <p className="alarm-card__action">{guide.action}</p>
              {ackingId === alarm.id ? (
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
                      type="submit"
                      className="btn btn-primary"
                      disabled={saving || note.trim().length < 3}
                    >
                      {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setAckingId(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary alarm-card__ack"
                  onClick={() => startAck(alarm.id)}
                >
                  Reconocer
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default GuardAlarmsPanel;
