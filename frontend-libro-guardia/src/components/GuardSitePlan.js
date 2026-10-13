import React, { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '../services/api';
import { doorLivePresentation } from '../utils/doorLiveState';
import { readCachedPlan, writeCachedPlan } from '../pages/Admin/SitePlan/sitePlanCache';
import { useSitePlanZoom } from '../pages/Admin/SitePlan/useSitePlanZoom';
import './GuardSitePlan.css';

export const hasMapPos = (door) => {
  const pos = door?.mapPos;
  return Boolean(pos) && Number.isFinite(pos.x) && Number.isFinite(pos.y);
};

/** Pide solo la versión y baja la imagen si cambió (misma caché que admin). */
export async function loadGuardSitePlan(authToken) {
  const meta = await apiFetch('/guard/site-plan/meta', { token: authToken });
  const version = meta?.version ?? null;
  if (version == null) {
    writeCachedPlan(null);
    return null;
  }
  const cached = readCachedPlan(version);
  if (cached) return cached;
  const data = await apiFetch('/guard/site-plan', { token: authToken });
  if (data?.plan) writeCachedPlan(data.plan);
  return data?.plan || null;
}

/** Color del punto y estado en palabras simples. */
export function doorPlanStatus(door) {
  const live = doorLivePresentation(door);
  const state = String(door?.live?.state || '').toUpperCase();
  switch (live.tone) {
    case 'ok':
      return { color: 'green', text: 'Cerrada' };
    case 'open':
      return { color: 'yellow', text: 'Abierta' };
    case 'warn':
      return { color: 'red', text: 'Abierta demasiado tiempo' };
    case 'danger':
      return { color: 'red', text: state === 'FORZADA' ? 'Forzada' : 'Falla de cerradura' };
    case 'offline':
      return { color: 'gray', text: 'Sin conexión' };
    default:
      return { color: 'gray', text: door?.controllerId ? 'Sin datos por ahora' : 'Sin equipo' };
  }
}

const LEGEND = [
  { color: 'green', text: 'Cerrada' },
  { color: 'yellow', text: 'Abierta' },
  { color: 'red', text: 'Forzada o con problema' },
  { color: 'gray', text: 'Sin equipo o sin datos' }
];

function GuardSitePlan({ plan, doors, onOpenDoor, openingId, onShowList }) {
  const viewportRef = useRef(null);
  const { zoom, canZoomIn, canZoomOut, zoomIn, zoomOut, fitZoom } = useSitePlanZoom(viewportRef);
  const [selectedId, setSelectedId] = useState(null);

  const placed = useMemo(() => doors.filter(hasMapPos), [doors]);
  const unplacedCount = doors.length - placed.length;
  const selected = placed.find((door) => door.id === selectedId) || null;
  const selectedStatus = selected ? doorPlanStatus(selected) : null;

  return (
    <div className="guard-plan">
      <div className="guard-plan__toolbar" role="toolbar" aria-label="Zoom del plano">
        <button type="button" className="btn btn-secondary" aria-label="Alejar" disabled={!canZoomOut} onClick={zoomOut}>−</button>
        <button type="button" className="btn btn-secondary" aria-label="Acercar" disabled={!canZoomIn} onClick={zoomIn}>+</button>
        <button type="button" className="btn btn-secondary" onClick={fitZoom}>Ajustar</button>
      </div>

      <div ref={viewportRef} className="guard-plan__viewport">
        <div className="guard-plan__stage" style={{ width: `${zoom * 100}%` }}>
          <img
            className="guard-plan__image"
            src={plan.imageDataUrl}
            width={plan.width}
            height={plan.height}
            alt="Plano del predio"
            draggable={false}
          />
          {placed.map((door) => {
            const status = doorPlanStatus(door);
            const name = door.name || door.id;
            const isSelected = door.id === selectedId;
            return (
              <button
                key={door.id}
                type="button"
                data-testid={`guard-plan-dot-${door.id}`}
                className={`guard-plan__dot guard-plan__dot--${status.color}${isSelected ? ' is-selected' : ''}`}
                style={{ left: `${door.mapPos.x * 100}%`, top: `${door.mapPos.y * 100}%` }}
                aria-label={`${name}: ${status.text}`}
                aria-pressed={isSelected}
                onClick={() => setSelectedId(isSelected ? null : door.id)}
              >
                <span className="guard-plan__label" aria-hidden="true">{name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {selected && (
        <div className="guard-plan__card" role="region" aria-label={`Puerta ${selected.name || selected.id}`}>
          <div className="guard-plan__card-head">
            <span className={`guard-plan__swatch guard-plan__swatch--${selectedStatus.color}`} aria-hidden="true" />
            <div>
              <strong>{selected.name || selected.id}</strong>
              <span className="guard-plan__card-status">{selectedStatus.text}</span>
            </div>
            <button
              type="button"
              className="guard-plan__close"
              aria-label="Cerrar"
              onClick={() => setSelectedId(null)}
            >
              <X size={16} />
            </button>
          </div>
          {selected.manualOpenAllowed !== false && (
            <button
              type="button"
              className="btn btn-primary guard-plan__open"
              disabled={Boolean(openingId)}
              onClick={() => onOpenDoor(selected)}
            >
              {openingId === selected.id ? 'Abriendo…' : 'Abrir puerta'}
            </button>
          )}
        </div>
      )}

      <ul className="guard-plan__legend" aria-label="Qué significa cada color">
        {LEGEND.map((item) => (
          <li key={item.color}>
            <span className={`guard-plan__swatch guard-plan__swatch--${item.color}`} aria-hidden="true" />
            {item.text}
          </li>
        ))}
      </ul>

      {unplacedCount > 0 && (
        <p className="guard-plan__unplaced">
          {unplacedCount === 1 ? '1 puerta no está en el plano.' : `${unplacedCount} puertas no están en el plano.`}{' '}
          <button type="button" className="guard-plan__link" onClick={onShowList}>Ver la lista</button>
        </p>
      )}
    </div>
  );
}

export default GuardSitePlan;
