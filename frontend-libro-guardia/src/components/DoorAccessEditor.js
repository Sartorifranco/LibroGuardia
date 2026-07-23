import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../services/api';

/**
 * Multi-select de puertas → allowedDoorIds (string[]).
 * Default / vacío = ninguna puerta (hay que marcar explícitamente).
 * Con forceRestricted: mismo UI (destinos / secuencias de puertas).
 */
function DoorAccessEditor({
  authToken,
  allowedDoorIds,
  onChange,
  disabled = false,
  highlight = false,
  forceRestricted = false,
  label = '¿Por qué puertas puede ingresar?',
  hint = 'Sin puertas marcadas = no puede ingresar por ninguna. El egreso no se restringe por puerta.'
}) {
  const [doors, setDoors] = useState([]);
  const [selected, setSelected] = useState(
    Array.isArray(allowedDoorIds) ? allowedDoorIds : []
  );

  useEffect(() => {
    setSelected(Array.isArray(allowedDoorIds) ? allowedDoorIds.filter(Boolean) : []);
  }, [allowedDoorIds]);

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

  const toggleDoor = (doorId) => {
    const next = selected.includes(doorId)
      ? selected.filter((id) => id !== doorId)
      : [...selected, doorId];
    setSelected(next);
    onChange(next.filter(Boolean));
  };

  const doorOptions = useMemo(
    () => doors.map((d) => ({ id: d.id, label: d.name || d.id })),
    [doors]
  );

  return (
    <div className={`door-access-editor${highlight ? ' door-access-editor--highlight' : ''}`}>
      <p className="door-access-editor__label">{label}</p>
      {hint ? <p className="door-access-editor__hint">{hint}</p> : null}
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
      {selected.length === 0 && doorOptions.length > 0 && (
        <p className="historial-meta" style={{ marginTop: '0.5rem' }}>
          Ninguna puerta seleccionada — no podrá ingresar por el molinete ni por ninguna puerta.
        </p>
      )}
    </div>
  );
}

export default DoorAccessEditor;
