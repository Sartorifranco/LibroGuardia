import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, PageContainer, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useToast } from '../../../context/ToastContext';
import { compressPlanImage } from './sitePlanImage';
import { readCachedPlan, writeCachedPlan } from './sitePlanCache';
import { useSitePlanZoom } from './useSitePlanZoom';
import './SitePlan.css';

const PURPOSE = 'Ver dónde está cada puerta sobre el plano real del predio.';
const DRAG_THRESHOLD = 5;

const hasPos = (door) => {
  const pos = door?.mapPos;
  return Boolean(pos) && Number.isFinite(pos.x) && Number.isFinite(pos.y);
};

const round4 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

const kindLabel = (door) => (door.kind === 'gate' ? 'Portón' : 'Puerta');

function SitePlanSection() {
  const { authToken } = useAuth();
  const { confirm } = useConfirm();
  const { showSuccess, showError } = useToast();
  const [plan, setPlan] = useState(null);
  const [doors, setDoors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [placingId, setPlacingId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const fileRef = useRef(null);
  const viewportRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null);
  const draggedRef = useRef(false);

  const loadPlan = useCallback(async () => {
    const meta = await apiFetch('/admin/site-plan/meta', { token: authToken });
    const version = meta?.version ?? null;
    if (version == null) {
      writeCachedPlan(null);
      return null;
    }
    const cached = readCachedPlan(version);
    if (cached) return cached;
    const data = await apiFetch('/admin/site-plan', { token: authToken });
    if (data?.plan) writeCachedPlan(data.plan);
    return data?.plan || null;
  }, [authToken]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextPlan, config] = await Promise.all([
        loadPlan(),
        apiFetch('/admin/doors-config', { token: authToken })
      ]);
      setPlan(nextPlan);
      setDoors(config?.meta?.legacyFallback ? [] : (config?.config?.doors || []));
    } catch (err) {
      setError(err.message || 'No se pudo leer el plano.');
    } finally {
      setLoading(false);
    }
  }, [authToken, loadPlan]);

  useEffect(() => { load(); }, [load]);

  const { zoom, canZoomIn, canZoomOut, zoomIn, zoomOut, fitZoom } = useSitePlanZoom(viewportRef);

  const pickFile = () => {
    setUploadError('');
    fileRef.current?.click();
  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const body = await compressPlanImage(file);
      const data = await apiFetch('/admin/site-plan', { method: 'PUT', token: authToken, body });
      const saved = data?.plan || { ...body, version: (plan?.version || 0) + 1 };
      writeCachedPlan(saved);
      setPlan(saved);
      fitZoom();
      showSuccess('Plano guardado.');
    } catch (err) {
      const message = err.message || 'No se pudo subir el plano.';
      setUploadError(message);
      showError(message);
    } finally {
      setUploading(false);
    }
  };

  const changePlan = async () => {
    const ok = await confirm({
      title: 'Cambiar plano',
      message: 'Las puertas mantienen su posición relativa sobre la imagen. Si el plano nuevo tiene otro encuadre, revisá que cada punto quede en su lugar.',
      confirmLabel: 'Elegir imagen'
    });
    if (ok) pickFile();
  };

  const saveDoorPos = async (doorId, mapPos) => {
    setSaving(true);
    try {
      const current = await apiFetch('/admin/doors-config', { token: authToken });
      const currentDoors = current?.config?.doors || [];
      if (!currentDoors.some((door) => door.id === doorId)) {
        throw new Error('Esa puerta ya no existe. Recargá la pantalla.');
      }
      const nextDoors = currentDoors.map((door) => (door.id === doorId ? { ...door, mapPos } : door));
      const data = await apiFetch('/admin/doors-config', {
        method: 'PUT',
        token: authToken,
        body: { doors: nextDoors, defaultDoorId: current?.config?.defaultDoorId ?? null }
      });
      setDoors(data?.config?.doors || nextDoors);
      return true;
    } catch (err) {
      showError(err.message || 'No se pudo guardar la ubicación.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const doorName = (id) => {
    const door = doors.find((item) => item.id === id);
    return door?.name || id;
  };

  const startPlacing = (doorId) => {
    setSelectedId(null);
    setPlacingId(doorId);
  };

  const onViewportPointerDown = (event) => {
    draggedRef.current = false;
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const viewport = viewportRef.current;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop
    };
  };

  const onViewportPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    draggedRef.current = true;
    viewportRef.current.scrollLeft = drag.left - dx;
    viewportRef.current.scrollTop = drag.top - dy;
  };

  const endDrag = () => { dragRef.current = null; };

  const onStageClick = async (event) => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (!placingId) {
      setSelectedId(null);
      return;
    }
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const mapPos = {
      x: round4((event.clientX - rect.left) / rect.width),
      y: round4((event.clientY - rect.top) / rect.height)
    };
    const name = doorName(placingId);
    const ok = await saveDoorPos(placingId, mapPos);
    if (ok) {
      showSuccess(`«${name}» quedó ubicada en el plano.`);
      setPlacingId(null);
    }
  };

  const onDotClick = (event, doorId) => {
    if (placingId) return;
    event.stopPropagation();
    setSelectedId((prev) => (prev === doorId ? null : doorId));
  };

  const removeFromPlan = async (doorId) => {
    const name = doorName(doorId);
    const ok = await saveDoorPos(doorId, null);
    if (ok) {
      showSuccess(`«${name}» se sacó del plano.`);
      setSelectedId(null);
    }
  };

  const placed = doors.filter(hasPos);
  const unplaced = doors.filter((door) => !hasPos(door));
  const selected = doors.find((door) => door.id === selectedId) || null;

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      hidden
      onChange={onFile}
      aria-label="Elegir imagen del plano"
      data-testid="site-plan-file"
    />
  );

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Plano del predio"
        purpose={PURPOSE}
        howTo={[
          'Subí una foto o imagen del plano de la planta.',
          'En la lista de puertas sin ubicar, tocá una puerta.',
          'Tocá en el plano el lugar donde está esa puerta.'
        ]}
        action={plan ? (
          <button type="button" className="btn btn-secondary" disabled={uploading} onClick={changePlan}>
            Cambiar plano
          </button>
        ) : null}
      />
      {fileInput}

      {loading ? <p role="status">Cargando el plano…</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
        </div>
      ) : null}
      {uploading ? <p role="status">Preparando y subiendo la imagen…</p> : null}
      {uploadError ? <p className="aui-error" role="alert">{uploadError}</p> : null}

      {!loading && !error && !plan ? (
        <EmptyState
          title="Subí el plano de la planta"
          text="Puede ser una foto o un escaneo del plano. Después marcás encima dónde está cada puerta."
          actionLabel={uploading ? undefined : 'Subir plano'}
          onAction={uploading ? undefined : pickFile}
        />
      ) : null}

      {!loading && !error && plan ? (
        <div className="site-plan">
          <div className="site-plan__main">
            <div className="site-plan__toolbar" role="toolbar" aria-label="Zoom del plano">
              <button type="button" className="btn btn-secondary" aria-label="Alejar" disabled={!canZoomOut} onClick={zoomOut}>−</button>
              <button type="button" className="btn btn-secondary" aria-label="Acercar" disabled={!canZoomIn} onClick={zoomIn}>+</button>
              <button type="button" className="btn btn-secondary" onClick={fitZoom}>Ajustar</button>
              <span className="site-plan__legend">
                <span className="site-plan__dot site-plan__dot--legend" /> Puerta
                <span className="site-plan__dot site-plan__dot--legend is-gate" /> Portón
                <span className="site-plan__dot site-plan__dot--legend is-airlock" /> En un estanco
              </span>
            </div>

            {placingId ? (
              <div className="site-plan__hint" role="status">
                <span>Tocá en el plano dónde está «{doorName(placingId)}»</span>
                <button type="button" className="btn btn-secondary" onClick={() => setPlacingId(null)}>Cancelar</button>
              </div>
            ) : null}

            <div
              ref={viewportRef}
              className={`site-plan__viewport${placingId ? ' is-placing' : ''}${zoom > 1 ? ' is-zoomed' : ''}`}
              onPointerDown={onViewportPointerDown}
              onPointerMove={onViewportPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
              onPointerCancel={endDrag}
            >
              <div
                className="site-plan__stage"
                style={{ width: `${zoom * 100}%` }}
                onClick={onStageClick}
              >
                <img
                  ref={imgRef}
                  src={plan.imageDataUrl}
                  alt="Plano del predio"
                  width={plan.width}
                  height={plan.height}
                  draggable={false}
                  className="site-plan__image"
                />
                {placed.map((door) => {
                  const classes = ['site-plan__dot'];
                  if (door.kind === 'gate') classes.push('is-gate');
                  if (door.airlockGroupId) classes.push('is-airlock');
                  if (door.id === selectedId) classes.push('is-selected');
                  return (
                    <button
                      key={door.id}
                      type="button"
                      className={classes.join(' ')}
                      style={{ left: `${door.mapPos.x * 100}%`, top: `${door.mapPos.y * 100}%` }}
                      aria-label={door.name || door.id}
                      aria-pressed={door.id === selectedId}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => onDotClick(event, door.id)}
                    >
                      <span className="site-plan__label">{door.name || door.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {selected ? (
              <div className="site-plan__selected" role="region" aria-label={`Puerta ${selected.name || selected.id}`}>
                <strong>{selected.name || selected.id}</strong>
                <span className="aui-card__meta">
                  {kindLabel(selected)}{selected.airlockGroupId ? ' · en un estanco' : ''}
                </span>
                <div className="site-plan__selected-actions">
                  <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => startPlacing(selected.id)}>Mover</button>
                  <button type="button" className="btn btn-danger-small" disabled={saving} onClick={() => removeFromPlan(selected.id)}>Quitar del plano</button>
                </div>
              </div>
            ) : null}
          </div>

          <aside className="site-plan__side" aria-label="Puertas sin ubicar">
            <h4 className="aui-card__title">Puertas sin ubicar</h4>
            {doors.length === 0 ? (
              <p className="aui-card__meta">Todavía no hay puertas. Cargalas en Puertas y después volvé acá.</p>
            ) : null}
            {doors.length > 0 && unplaced.length === 0 ? (
              <p className="aui-card__meta">Todas las puertas están en el plano.</p>
            ) : null}
            {unplaced.length > 0 ? (
              <ul className="site-plan__list">
                {unplaced.map((door) => (
                  <li key={door.id}>
                    <button
                      type="button"
                      className={`site-plan__list-item${placingId === door.id ? ' is-active' : ''}`}
                      disabled={saving}
                      aria-pressed={placingId === door.id}
                      onClick={() => startPlacing(door.id)}
                    >
                      <span>{door.name || door.id}</span>
                      <span className="aui-card__meta">{kindLabel(door)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </aside>
        </div>
      ) : null}
    </PageContainer>
  );
}

export default SitePlanSection;
