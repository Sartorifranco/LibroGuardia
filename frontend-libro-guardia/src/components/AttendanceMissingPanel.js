import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  UserCheck,
  UserX,
  Clock,
} from 'lucide-react';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

const STATUS_LABELS = {
  present: 'En planta',
  missing: 'Sin ingreso',
  absent: 'Fuera de planta',
  pending: 'Pendiente',
};

function AttendanceMissingPanel({ authToken, enabled = true, pollSeconds = 60, onRegistered }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [areaFilter, setAreaFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const onRegisteredRef = useRef(onRegistered);
  onRegisteredRef.current = onRegistered;

  const fetchMissing = useCallback(async (manual = false) => {
    if (!authToken || !enabled) return;
    if (manual) setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/guard/attendance/missing`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Error al cargar asistencia');
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
    fetchMissing(false);
    if (!enabled) return undefined;
    const timer = setInterval(() => fetchMissing(false), Math.max(pollSeconds, 30) * 1000);
    return () => clearInterval(timer);
  }, [fetchMissing, enabled, pollSeconds]);

  const roster = useMemo(() => data?.roster || data?.missing || [], [data]);

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
    const ids = selectableItems.map((item) => item.personalMasterId);
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(ids));
    }
  };

  const selectedItems = useMemo(
    () => filteredRoster.filter((item) => selectedIds.has(item.personalMasterId)),
    [filteredRoster, selectedIds]
  );

  const bulkPresent = async (items) => {
    if (!items.length) return;
    setActing(true);
    try {
      const response = await fetch(`${API_BASE_URL}/guard/attendance/bulk-present`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ items })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'No se pudo registrar');
      onRegisteredRef.current?.(items[0]);
      await fetchMissing(false);
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
      const response = await fetch(`${API_BASE_URL}/guard/attendance/bulk-absent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ items, reason: 'ausente_guardia' })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'No se pudo marcar ausente');
      await fetchMissing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setActing(false);
    }
  };

  const registerEntry = (item) => bulkPresent([item]);
  const dismissAlert = (item) => bulkAbsent([item]);

  const markAllFilteredPresent = () => {
    const targets = selectableItems;
    if (targets.length) bulkPresent(targets);
  };

  if (!enabled) return null;

  const missingCount = data?.missingCount ?? roster.filter((r) => r.status === 'missing').length;
  const areas = data?.areas || [];
  const selectedAreaMeta = areas.find((area) => area.key === areaFilter);
  const allVisibleSelected = selectableItems.length > 0
    && selectableItems.every((item) => selectedIds.has(item.personalMasterId));

  return (
    <section className={`attendance-panel${missingCount ? ' attendance-panel--alert' : ''}`}>
      <div className="attendance-panel__header">
        <div>
          <p className="attendance-panel__kicker">Personal en planta</p>
          <h3 className="attendance-panel__title">Ingresos del día (por turno)</h3>
          {data && (
            <p className="attendance-panel__subtitle">
              {data.presentCount}/{data.expectedCount} en planta
              {data.absentCount ? ` · ${data.absentCount} fuera de planta` : ''}
              {data.pendingCount ? ` · ${data.pendingCount} pendientes` : ''}
              {data.plantNominaTotal != null
                ? ` · ${data.plantNominaTotal} en nómina (plantas por turno)`
                : data.nominaTotal != null
                  ? ` · ${data.nominaTotal} en nómina`
                  : ''}
              {data.citacionNominaTotal ? ` · ${data.citacionNominaTotal} Transporte/Tesorería (ver Citados)` : ''}
              {data.time ? ` · ${data.time}` : ''}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary attendance-panel__refresh"
          onClick={() => fetchMissing(true)}
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
                <option value="all">Todas ({roster.length})</option>
                {areas.map((area) => (
                  <option key={area.key} value={area.key}>
                    {area.label}
                    {' '}
                    ({area.expectedToday}/{area.totalInNomina})
                  </option>
                ))}
              </select>
            </label>

            <div className="attendance-toolbar__actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={acting || selectableItems.length === 0}
                onClick={markAllFilteredPresent}
              >
                Marcar todos en planta
                {areaFilter !== 'all' ? ' (filtro)' : ''}
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
                  <th>Área</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredRoster.map((item) => (
                  <tr
                    key={item.personalMasterId}
                    className={`attendance-table__row attendance-table__row--${item.status}`}
                  >
                    <td className="attendance-table__check">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.personalMasterId)}
                        disabled={item.status === 'present'}
                        onChange={() => toggleSelect(item.personalMasterId)}
                        aria-label={`Seleccionar ${item.name}`}
                      />
                    </td>
                    <td className="attendance-table__name">{item.name}</td>
                    <td>{item.legajo || '—'}</td>
                    <td className="attendance-table__centro" title={item.centroCosto || undefined}>
                      {item.areaShort || item.centroCosto || '—'}
                    </td>
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
                          onClick={() => registerEntry(item)}
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
                          onClick={() => dismissAlert(item)}
                          title="Marcar fuera de planta"
                        >
                          <UserX size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredRoster.length === 0 && areaFilter !== 'all' && (
            <p className="attendance-panel__empty">
              Nadie de {selectedAreaMeta?.label || 'esta área'} esperado hoy
              {selectedAreaMeta?.totalInNomina
                ? ` (${selectedAreaMeta.totalInNomina} en nómina)`
                : ''}.
            </p>
          )}
        </>
      )}

      {!error && roster.length === 0 && (
        <p className="attendance-panel__empty">
          <CheckCircle size={18} className="inline mr-1" />
          {data?.message || 'Sin personal esperado hoy.'}
        </p>
      )}
    </section>
  );
}

export default AttendanceMissingPanel;
