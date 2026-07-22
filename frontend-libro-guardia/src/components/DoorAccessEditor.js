import React, { useEffect, useId, useMemo, useState } from 'react';
import { apiFetch } from '../services/api';

/**
 * Selector Todas / Solo estas puertas → allowedDoorIds (null | string[]).
 * Con forceRestricted: solo multi-select (destinos / secuencias de puertas).
 */
function DoorAccessEditor({
  authToken,
  allowedDoorIds,
  onChange,
  disabled = false,
  highlight = false,
  forceRestricted = false,
  label = '¿Por qué puertas puede ingresar?',
  hint = 'Solo afecta el ingreso. El egreso no se restringe por puerta.'
}) {
  const radioGroupId = useId();
  const [doors, setDoors] = useState([]);
  const [mode, setMode] = useState(() => {
    if (forceRestricted) return 'restricted';
    return Array.isArray(allowedDoorIds) && allowedDoorIds.length ? 'restricted' : 'all';
  });
  const [selected, setSelected] = useState(
    Array.isArray(allowedDoorIds) ? allowedDoorIds : []
  );

  useEffect(() => {
    if (forceRestricted) {
      setMode('restricted');
      setSelected(Array.isArray(allowedDoorIds) ? allowedDoorIds : []);
      return;
    }
    const restricted = Array.isArray(allowedDoorIds) && allowedDoorIds.length > 0;
    setMode(restricted ? 'restricted' : 'all');
    setSelected(restricted ? allowedDoorIds : []);
  }, [allowedDoorIds, forceRestricted]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true });
        if (cancelled) return;
        setDoors((data.config?.doors || []).filter((d) => d.active !== false));
      } catch {
        if (!cancelled) setDoors([]);
      }
    })();
    return () => { cancelled = true; };
  }, [authToken]);

  const emit = (nextMode, nextSelected) => {
    if (!forceRestricted && nextMode === 'all') onChange(null);
    else onChange(nextSelected.filter(Boolean));
  };

  const toggleDoor = (doorId) => {
    const next = selected.includes(doorId)
      ? selected.filter((id) => id !== doorId)
      : [...selected, doorId];
    setSelected(next);
    emit('restricted', next);
  };

  const doorOptions = useMemo(
    () => doors.map((d) => ({ id: d.id, label: d.name || d.id })),
    [doors]
  );

  return (
    <div className={`door-access-editor${highlight ? ' door-access-editor--highlight' : ''}`}>
      <p className="door-access-editor__label">{label}</p>
      {hint ? <p className="door-access-editor__hint">{hint}</p> : null}
      {!forceRestricted && (
        <div className="door-access-editor__modes">
          <label className="door-access-editor__mode">
            <input
              type="radio"
              name={`door-access-mode-${radioGroupId}`}
              checked={mode === 'all'}
              disabled={disabled}
              onChange={() => {
                setMode('all');
                setSelected([]);
                emit('all', []);
              }}
            />
            Todas las puertas
          </label>
          <label className="door-access-editor__mode">
            <input
              type="radio"
              name={`door-access-mode-${radioGroupId}`}
              checked={mode === 'restricted'}
              disabled={disabled}
              onChange={() => {
                setMode('restricted');
                emit('restricted', selected);
              }}
            />
            Solo estas puertas
          </label>
        </div>
      )}
      {(forceRestricted || mode === 'restricted') && (
        <div className="door-access-editor__doors">
          {doorOptions.length === 0 && (
            <span className="historial-meta">No hay puertas configuradas</span>
          )}
          {doorOptions.map((door) => (
            <label key={door.id} className="door-access-editor__door">
              <input
                type="checkbox"
                checked={selected.includes(door.id)}
                disabled={disabled}
                onChange={() => toggleDoor(door.id)}
              />
              {door.label}
              {forceRestricted && selected.includes(door.id) && (
                <span className="historial-meta"> · #{selected.indexOf(door.id) + 1}</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default DoorAccessEditor;
