import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../services/api';
import { useAuth } from '../context/AuthContext';

function formatWhen(value) {
  if (!value) return '—';
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '—';
  }
}

function ActivityPanel() {
  const { authToken } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/activity?limit=50', {
        token: authToken,
        allowForbidden: true
      });
      setItems(Array.isArray(data.activity) ? data.activity : []);
    } catch (err) {
      setError(err.message || 'No se pudo cargar la auditoría');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="activity-panel admin-sub-section">
      <div className="activity-panel__toolbar">
        <p className="activity-panel__hint">
          Últimas acciones administrativas (eliminaciones y cambios relevantes).
        </p>
        <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Actualizar
        </button>
      </div>

      {error && <div className="activity-panel__error">{error}</div>}

      {loading && !items.length ? (
        <div className="activity-panel__loading">
          <Loader2 className="animate-spin" size={28} />
          <span>Cargando actividad…</span>
        </div>
      ) : !items.length && !error ? (
        <div className="activity-panel__empty">
          <Activity size={22} aria-hidden />
          <span>Todavía no hay eventos registrados.</span>
        </div>
      ) : (
        <ul className="activity-panel__list">
          {items.map((item) => (
            <li key={item.id} className="activity-panel__item">
              <div className="activity-panel__summary">{item.summary || item.action || 'Acción'}</div>
              <div className="activity-panel__meta">
                <span>{item.actorUsername || item.actorId || 'Sistema'}</span>
                <span>{formatWhen(item.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ActivityPanel;
