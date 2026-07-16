import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  UserCheck,
  UserX,
  Clock,
} from 'lucide-react';
import { apiFetch } from '../services/api';

const STATUS_LABELS = {
  present: 'En planta',
  missing: 'Sin ingreso',
  absent: 'Fuera de planta',
  pending: 'Pendiente',
};

const itemKey = (item) => item.citacionId || item.personalMasterId || `${item.legajo}-${item.idNumber}`;

function CitadosPanel({ authToken, enabled = true, pollSeconds = 60, onRegistered }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [areaFilter, setAreaFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const onRegisteredRef = useRef(onRegistered);
  onRegisteredRef.current = onRegistered;

  const fetchCitados = useCallback(async (manual = false) => {
    if (!authToken || !enabled) return;
    if (manual) setLoading(true);
    try {
      const payload = await apiFetch('/guard/citados/today', { token: authToken });
      setData(payload);
      setError('');
      setSelectedIds(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      if (manual) setLoading(false);
    }
  }, [authToken, enabled]);

  useEffect(() => {
    fetchCitados(false);
    if (!enabled) return undefined;
    const timer = setInterval(() => fetchCitados(false), Math.max(pollSeconds, 30) * 1000);
    return () => clearInterval(timer);
  }, [fetchCitados, enabled, pollSeconds]);

  const roster = useMemo(() => data?.roster || [], [data]);

  const filteredRoster = useMemo(() => {
    if (areaFilter === 'all') return roster;
    return roster.filter((item) => (item.areaKey || '__empty__') === areaFilter);
  }, [roster, areaFilter]);

  const selectableItems = useMemo(
    () => filteredRoster.filter((item) => item.status !== 'present'),
    [filteredRoster]
  );

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    const ids = selectableItems.map((item) => itemKey(item));
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(ids));
  };

  const selectedItems = useMemo(
    () => filteredRoster.filter((item) => selectedIds.has(itemKey(item))),
    [filteredRoster, selectedIds]
  );

  const bulkPresent = async (items) => {
    if (!items.length) return;
    setActing(true);
    try {
      await apiFetch('/guard/attendance/bulk-present', {
        method: 'POST',
        token: authToken,
        body: { items }
      });
      onRegisteredRef.current?.(items[0]);
      await fetchCitados(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setActing(false);
    }
  };

  const bulkAbsent = async (items) => {
    if (!items.length) return;
    setActing(true);
    try {
      await apiFetch('/guard/attendance/bulk-absent', {
        method: 'POST',
        token: authToken,
        body: { items, reason: 'ausente_guardia' }
      });
      await fetchCitados(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setActing(false);
    }
  };

  if (!enabled) return null;

  const missingCount = data?.missingCount ?? roster.filter((r) => r.status === 'missing').length;
  const areas = data?.areas || [];
  const selectedAreaMeta = areas.find((area) => area.key === areaFilter);
  const allVisibleSelected = selectableItems.length > 0
    && selectableItems.every((item) => selectedIds.has(itemKey(item)));

  return (
    <section className={`attendance-panel citados-panel${missingCount ? ' attendance-panel--alert' : ''}`}>
      <div className="attendance-panel__header">
        <div>
          <p className="attendance-panel__kicker">Citados</p>
          <h3 className="attendance-panel__title">Transporte, Tesorería y Grúas</h3>
          <p className="attendance-panel__purpose">
            Control de asistencia — quién llegó hoy de lo esperado.
          </p>
          {data && (
            <p className="attendance-panel__subtitle">
              {data.presentCount}/{data.expectedCount} en planta
              {data.absentCount ? ` · ${data.absentCount} fuera de planta` : ''}
              {data.pendingCount ? ` · ${data.pendingCount} pendientes` : ''}
              {data.citacionesTotal != null ? ` · ${data.citacionesTotal} en planilla` : ''}
              {data.matchedNomina != null ? ` · ${data.matchedNomina} en nómina` : ''}
              {data.unmatchedCitaciones ? (
                <span className="citados-unmatched-warn"> · {data.unmatchedCitaciones} solo en planilla (sin nómina)</span>
              ) : null}
              {data.time ? ` · ${data.time}` : ''}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary attendance-panel__refresh"
          onClick={() => fetchCitados(true)}
          disabled={loading || acting}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          Actualizar
        </button>
      </div>

      {error && <p className="attendance-panel__error">{error}</p>}

      {roster.length > 0 && (
        <>
          <div className="attendance-toolbar">
            <label className="attendance-filter">
              <span>Área</span>
              <select
                value={areaFilter}
                onChange={(e) => {
                  setAreaFilter(e.target.value);
                  setSelectedIds(new Set());
                }}
              >
                <option value="all">Todos ({roster.length})</option>
                {areas.map((area) => (
                  <option key={area.key} value={area.key}>
                    {area.label} ({area.presentToday}/{area.expectedToday})
                  </option>
                ))}
              </select>
            </label>

            <div className="attendance-toolbar__actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={acting || selectableItems.length === 0}
                onClick={() => bulkPresent(selectableItems)}
              >
                Marcar todos en planta
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={acting || selectedItems.filter((i) => i.status !== 'present').length === 0}
                onClick={() => bulkPresent(selectedItems.filter((i) => i.status !== 'present'))}
              >
                En planta ({selectedItems.filter((i) => i.status !== 'present').length})
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={acting || selectedItems.filter((i) => i.status !== 'absent' && i.status !== 'present').length === 0}
                onClick={() => bulkAbsent(selectedItems.filter((i) => i.status !== 'absent' && i.status !== 'present'))}
              >
                Fuera de planta ({selectedItems.filter((i) => i.status !== 'absent' && i.status !== 'present').length})
              </button>
            </div>
          </div>

          <div className="attendance-table-wrap scroll-panel-max">
            <table className="attendance-table">
              <thead>
                <tr>
                  <th className="attendance-table__check">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={selectableItems.length === 0}
                      onChange={toggleSelectAllVisible}
                      aria-label="Seleccionar todos visibles"
                    />
                  </th>
                  <th>Nombre</th>
                  <th>Legajo</th>
                  <th>Área / Destino</th>
                  <th>Hora</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredRoster.map((item) => {
                  const key = itemKey(item);
                  return (
                    <tr
                      key={key}
                      className={`attendance-table__row attendance-table__row--${item.status}`}
                    >
                      <td className="attendance-table__check">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(key)}
                          disabled={item.status === 'present'}
                          onChange={() => toggleSelect(key)}
                          aria-label={`Seleccionar ${item.name}`}
                        />
                      </td>
                      <td className="attendance-table__name">
                        {item.name || '—'}
                        {item.nominaMatched === false && (
                          <span className="citados-planilla-badge" title="Citado en planilla, no vinculado a nómina">
                            planilla
                          </span>
                        )}
                      </td>
                      <td>{item.legajo || '—'}</td>
                      <td className="attendance-table__centro" title={[item.destination || item.centroCosto, item.role].filter(Boolean).join(' · ') || undefined}>
                        {[item.areaShort || item.destination || item.centroCosto, item.role].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td>{item.appointmentTime || item.entryTime || '—'}</td>
                      <td>
                        <span className={`attendance-status attendance-status--${item.status}`}>
                          {item.status === 'present' && <CheckCircle size={14} />}
                          {item.status === 'missing' && <AlertTriangle size={14} />}
                          {item.status === 'absent' && <UserX size={14} />}
                          {item.status === 'pending' && <Clock size={14} />}
                          {STATUS_LABELS[item.status] || item.status}
                        </span>
                      </td>
                      <td className="attendance-table__actions">
                        {item.status !== 'present' && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={acting}
                            onClick={() => bulkPresent([item])}
                            title="Marcar en planta"
                          >
                            <UserCheck size={14} />
                          </button>
                        )}
                        {item.status !== 'present' && item.status !== 'absent' && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={acting}
                            onClick={() => bulkAbsent([item])}
                            title="Marcar fuera de planta"
                          >
                            <UserX size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredRoster.length === 0 && areaFilter !== 'all' && (
            <p className="attendance-panel__empty">
              Sin citados de {selectedAreaMeta?.label || 'esta área'} hoy.
            </p>
          )}
        </>
      )}

      {!error && roster.length === 0 && (
        <p className="attendance-panel__empty">
          <CheckCircle size={18} className="inline mr-1" />
          {data?.message || 'Sin citaciones para hoy.'}
        </p>
      )}
    </section>
  );
}

export default CitadosPanel;
