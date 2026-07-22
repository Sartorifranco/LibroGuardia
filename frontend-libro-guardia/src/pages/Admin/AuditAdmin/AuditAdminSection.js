import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardList, ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from 'lucide-react';
import { AdminEmpty, AdminLoading } from '../../../components/admin/AdminUi';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { hasPermission } from '../../../utils/permissions';

const ACTION_OPTIONS = [
  { value: '', label: 'Todas las acciones' },
  { value: 'user.create', label: 'Usuario creado' },
  { value: 'user.update', label: 'Usuario editado' },
  { value: 'user.delete', label: 'Usuario eliminado' },
  { value: 'user.permissions.update', label: 'Permisos de usuario' },
  { value: 'role.create', label: 'Rol creado' },
  { value: 'role.update', label: 'Rol editado' },
  { value: 'role.delete', label: 'Rol eliminado' },
  { value: 'permissions.change', label: 'Permisos por rol' },
  { value: 'door.config.update', label: 'Config. puertas' }
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
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return '—';
  }
}

function entityLabel(item) {
  if (!item.targetType && !item.targetId) return '—';
  return [item.targetType, item.targetId].filter(Boolean).join(' · ');
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
    <div className="admin-sub-section audit-admin-section">
      <div className="activity-panel__toolbar" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <p className="theme-section-desc" style={{ margin: 0, flex: '1 1 220px' }}>
          Registro de cambios administrativos (usuarios, roles, permisos y puertas).
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="field-label" style={{ margin: 0 }}>
            Acción
            <select className="input-field" value={action} onChange={(e) => setAction(e.target.value)}>
              {ACTION_OPTIONS.map((opt) => (
                <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="field-label" style={{ margin: 0 }}>
            Desde
            <input className="input-field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field-label" style={{ margin: 0 }}>
            Hasta
            <input className="input-field" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Filtrar
          </button>
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            <RefreshCw size={16} />
            Actualizar
          </button>
        </div>
      </div>

      {error && <div className="activity-panel__error">{error}</div>}

      {loading && !items.length ? (
        <AdminLoading label="Cargando auditoría…" />
      ) : !items.length && !error ? (
        <AdminEmpty
          icon={ClipboardList}
          title="Todavía no hay eventos de auditoría"
          description="Los cambios administrativos (usuarios, roles, permisos, puertas) van a aparecer acá."
        />
      ) : (
        <div className="theme-panel-nested" style={{ overflowX: 'auto' }}>
          <table className="admin-table theme-table">
            <thead>
              <tr>
                <th />
                <th>Fecha</th>
                <th>Usuario</th>
                <th>Acción</th>
                <th>Entidad</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const open = expandedId === item.id;
                return (
                  <React.Fragment key={item.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary-small"
                          aria-expanded={open}
                          onClick={() => setExpandedId(open ? null : item.id)}
                        >
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatWhen(item.createdAt)}</td>
                      <td>{item.actorUsername || item.actorId || '—'}</td>
                      <td><code>{item.action}</code></td>
                      <td>{entityLabel(item)}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={5} style={{ padding: '0.75rem 1rem', background: 'var(--panel-muted)' }}>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <p className="field-label">Antes</p>
                              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>
                                {JSON.stringify(item.before ?? null, null, 2)}
                              </pre>
                            </div>
                            <div>
                              <p className="field-label">Después</p>
                              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>
                                {JSON.stringify(item.after ?? null, null, 2)}
                              </pre>
                            </div>
                          </div>
                          {(item.ip || item.userAgent) && (
                            <p className="theme-section-desc" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                              {item.ip ? `IP: ${item.ip}` : ''}
                              {item.ip && item.userAgent ? ' · ' : ''}
                              {item.userAgent ? `UA: ${item.userAgent}` : ''}
                            </p>
                          )}
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
