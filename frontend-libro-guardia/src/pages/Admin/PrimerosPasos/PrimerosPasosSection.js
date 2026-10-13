import React, { useCallback, useEffect, useState } from 'react';
import { PageHeader, Stepper } from '../../../components/admin-ui';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { guardiaPath } from '../../../utils/navigation';

const STATUS_LABEL = {
  done: 'Hecho',
  pending: 'Pendiente',
  optional: 'Opcional'
};

function PrimerosPasosSection({ onOpen }) {
  const { authToken } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/setup-status', { token: authToken, allowForbidden: true });
      setStatus(data);
    } catch (err) {
      setError(err.message || 'No se pudo revisar qué falta.');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p role="status">Revisando qué falta…</p>;
  if (error) {
    return (
      <div role="alert">
        <p>{error}</p>
        <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
      </div>
    );
  }
  if (!status) return null;

  if (status.complete) {
    const board = status.board || {};
    const problems = board.devicesProblem || [];
    return (
      <div>
        <PageHeader
          title="Tablero"
          purpose="El predio ya está configurado. Acá ves lo que necesita atención."
          howTo={[
            'Mirá si hay un equipo sin conexión.',
            'Revisá los pedidos de ingreso que esperan respuesta.',
            'Cerrá las alarmas que siguen abiertas.'
          ]}
        />
        <div className="aui-board">
          <article className="aui-card">
            <h4 className="aui-card__title">Equipos con problemas</h4>
            {problems.length === 0 ? (
              <p className="aui-card__meta">Ningún equipo en problema.</p>
            ) : (
              <ul>
                {problems.map((item) => <li key={item.id}>{item.name}</li>)}
              </ul>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => onOpen('equipos')}>Ver equipos</button>
          </article>
          <article className="aui-card">
            <h4 className="aui-card__title">Autorizaciones pendientes</h4>
            <p className="aui-card__meta">{board.pendingAuthorizations || 0} esperan respuesta.</p>
            <button type="button" className="btn btn-secondary" onClick={() => navigate(guardiaPath('autorizaciones'))}>Abrir la bandeja</button>
          </article>
          <article className="aui-card">
            <h4 className="aui-card__title">Alarmas abiertas</h4>
            <p className="aui-card__meta">{board.openAlarms || 0} sin cerrar.</p>
            <button type="button" className="btn btn-secondary" onClick={() => navigate(guardiaPath('alarmas'))}>Ver alarmas</button>
          </article>
        </div>
      </div>
    );
  }

  const steps = status.steps || [];
  const firstPending = steps.find((item) => item.status === 'pending')?.id;
  const current = Math.max(0, steps.findIndex((item) => item.status !== 'done'));
  const progress = status.progress || { done: 0, total: steps.length, percent: 0 };

  return (
    <div>
      <PageHeader
        title="Primeros pasos"
        purpose="Seguí este orden para dejar el predio listo. Podés saltear y volver."
        howTo={[
          'Empezá por el nombre de la empresa y las puertas.',
          'Después cargá personas, guardias y avisos.',
          'Al final probá si una persona puede pasar.'
        ]}
      />
      <p className="aui-card__meta">{progress.done} de {progress.total} listos</p>
      <div className="aui-progress" aria-hidden>
        <span style={{ width: `${progress.percent || 0}%` }} />
      </div>
      <div style={{ height: '0.75rem' }} />
      <Stepper steps={steps.map((item) => item.title)} current={current < 0 ? steps.length - 1 : current} />
      <ol className="aui-step-list">
        {steps.map((item) => (
          <li key={item.id} className="aui-step">
            <div className="aui-step__body">
              <h4>
                {item.title}
                {' '}
                <span className={`aui-status${item.status === 'done' ? ' is-ok' : item.status === 'pending' ? ' is-warn' : ''}`}>
                  {item.status === 'done' ? 'Hecho ✓' : STATUS_LABEL[item.status] || item.status}
                </span>
              </h4>
              <p>{item.what}</p>
              <p>{item.why}</p>
              {item.detail ? <p>{item.detail}</p> : null}
            </div>
            {item.status !== 'done' && item.section ? (
              <button
                type="button"
                className={item.id === firstPending ? 'btn btn-primary' : 'btn btn-secondary'}
                onClick={() => onOpen(item.section)}
              >
                Configurar
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default PrimerosPasosSection;
