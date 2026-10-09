import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { AdminLoading } from '../../../components/admin/AdminUi';
import PageHeader from '../../../components/admin-ui/PageHeader';
import EmptyState from '../../../components/admin-ui/EmptyState';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { hasPermission } from '../../../utils/permissions';
import {
  ACTION_LABELS,
  buildReadableChanges,
  formatActionLabel,
  formatTargetLabel
} from '../../../utils/auditLabels';

const ACTION_OPTIONS = [
  { value: '', label: 'Todas las acciones' },
  ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }))
];

function formatWhen(value) {
  if (!value) return '—';
  try {
    const date = new Date(value);
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

function AuditAdminSection() {
  const { authToken, currentUser } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const canView = hasPermission(currentUser, 'audit.view');

  const load = useCallback(async () => {
    if (!authToken || !canView) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (action) params.set('action', action);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const data = await apiFetch(`/admin/audit-log?${params.toString()}`, {
        token: authToken,
        allowForbidden: true
      });
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setError(err.message || 'No se pudo cargar la auditoría');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [authToken, canView, action, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canView) return null;

  return (
    <div className="admin-sub-section audit-admin-section admin-simple">
      <PageHeader
        title="Registro de cambios"
        purpose="Quién cambió qué en el sistema, y qué quedó distinto."
        howTo={[
          'Filtrá por tipo de cambio o por fechas.',
          'Abrí una fila para ver el antes y el después.',
          'Actualizá si acabás de hacer un cambio.'
        ]}
        action={(
          <button type="button" className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : null}
            Actualizar
          </button>
        )}
      />
      <div className="activity-panel__toolbar" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <label className="field-label" style={{ margin: 0 }}>
          Tipo de cambio
          <select className="input-field" aria-label="Tipo de cambio" value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
        <label className="field-label" style={{ margin: 0 }}>
          Desde
          <input className="input-field" aria-label="Desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field-label" style={{ margin: 0 }}>
          Hasta
          <input className="input-field" aria-label="Hasta" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {error && <div className="activity-panel__error">{error}</div>}

      {loading && !items.length ? (
        <AdminLoading label="Cargando auditoría…" />
      ) : !items.length && !error ? (
        <EmptyState
          title="Todavía no hay cambios"
          text="Cuando alguien cree o modifique usuarios, empresas o puertas, el cambio va a aparecer acá."
        />
      ) : (
        <div className="theme-panel-nested" style={{ overflowX: 'auto' }}>
          <table className="admin-table theme-table">
            <thead>
              <tr>
                <th />
                <th>Cuándo</th>
                <th>Quién</th>
                <th>Qué hizo</th>
                <th>Sobre qué</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const open = expandedId === item.id;
                const changes = buildReadableChanges(item.before, item.after, item.changedKeys);
                return (
                  <React.Fragment key={item.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary-small"
                          aria-expanded={open}
                          onClick={() => setExpandedId(open ? null : item.id)}
                          title="Ver detalle"
                        >
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatWhen(item.createdAt)}</td>
                      <td>{item.actorUsername || item.actorId || '—'}</td>
                      <td>{formatActionLabel(item.action)}</td>
                      <td>{formatTargetLabel(item)}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={5} style={{ padding: '0.75rem 1rem', background: 'var(--panel-muted)' }}>
                          {changes.length ? (
                            <div className="audit-changes">
                              <p className="field-label" style={{ marginBottom: '0.5rem' }}>Cambios</p>
                              <ul className="audit-changes__list">
                                {changes.map((c) => (
                                  <li key={`${item.id}-${c.field}`}>
                                    <strong>{c.label}</strong>
                                    {': '}
                                    <span className="audit-changes__from">{c.from}</span>
                                    {' → '}
                                    <span className="audit-changes__to">{c.to}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p className="theme-section-desc" style={{ margin: 0 }}>
                              Sin detalle de campos (acción registrada sin diferencias).
                            </p>
                          )}
                          {item.ip ? (
                            <p className="theme-section-desc" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                              Origen de la sesión:
                              {' '}
                              {item.ip}
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default AuditAdminSection;
