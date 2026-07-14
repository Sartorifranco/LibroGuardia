import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import L from 'leaflet';
import { Loader2, MapPin, RefreshCw, Pentagon, Trash2, Undo2, Save } from 'lucide-react';
import { formatFleetTime } from './FleetGpsVehicleTable';
import {
  GATE_TARGETS,
  normalizeGatePolygonsForSave,
  buildGatePolygonPatch
} from '../utils/fleetGpsGeofence';
import 'leaflet/dist/leaflet.css';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

const ZONE_LABELS = {
  gate: 'Port?n',
  plant: 'Planta',
  outside: 'Afuera',
  unknown: 'Sin zona'
};

const markerColor = (vehicle) => {
  if (vehicle.zone === 'gate') return vehicle.moving ? '#dc2626' : '#f97316';
  if (vehicle.zone === 'plant') return vehicle.moving ? '#2563eb' : '#16a34a';
  return vehicle.moving ? '#0891b2' : '#6b7280';
};

const buildMarkerIcon = (vehicle) => {
  const color = markerColor(vehicle);
  const moving = vehicle.moving;
  return L.divIcon({
    className: 'fleet-gps-map-marker-wrap',
    html: `<span class="fleet-gps-map-marker${moving ? ' fleet-gps-map-marker--moving' : ''}" style="background:${color}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10]
  });
};

const guardiaIcon = L.divIcon({
  className: 'fleet-gps-map-marker-wrap',
  html: '<span class="fleet-gps-map-guardia">G</span>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -12]
});

const knotsToKmh = (speed) => `${(Number(speed || 0) * 1.852).toFixed(1)} km/h`;

const buildPopupHtml = (vehicle) => `
  <div class="fleet-gps-map-popup">
    <strong>${vehicle.name || 'M?vil'}</strong>
    ${vehicle.plate ? `<div>Patente: ${vehicle.plate}</div>` : ''}
    <div>Zona: ${ZONE_LABELS[vehicle.zone] || vehicle.zone}</div>
    ${vehicle.gateName ? `<div>Port?n: ${vehicle.gateName}</div>` : ''}
    <div>${vehicle.moving ? 'En movimiento' : 'Detenido'} ? ${knotsToKmh(vehicle.speed)}</div>
    ${vehicle.distanceMeters != null ? `<div>Distancia port?n: ${vehicle.distanceMeters} m</div>` : ''}
    ${vehicle.fixTime ? `<div class="fleet-gps-map-popup__time">GPS: ${formatFleetTime(vehicle.fixTime) || vehicle.fixTime}</div>` : ''}
  </div>
`;

const DEFAULT_MAP_CENTER = [-31.4201, -64.1888];
const DEFAULT_MAP_ZOOM = 6;

const isValidCoord = (lat, lng) =>
  lat != null
  && lng != null
  && !Number.isNaN(Number(lat))
  && !Number.isNaN(Number(lng));

const normalizeGatePolygons = normalizeGatePolygonsForSave;

const FleetGpsLiveMap = forwardRef(function FleetGpsLiveMap({
  authToken,
  previewConfig,
  active = true,
  editable = false,
  onGeofenceChange,
  onGeofenceSaved,
  onGeofenceError
}, ref) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({
    gate: null,
    plant: null,
    approach: null,
    guardia: null,
    markers: null,
    polygons: [],
    draft: null
  });
  const fitKeyRef = useRef('');
  const mapViewLockedRef = useRef(false);
  const mapReadyRef = useRef(false);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drawTarget, setDrawTarget] = useState('gate-1');
  const [draftPoints, setDraftPoints] = useState([]);
  const [geofenceMessage, setGeofenceMessage] = useState('');
  const [savingGeofence, setSavingGeofence] = useState(false);

  useImperativeHandle(ref, () => ({
    commitDraft() {
      return buildGatePolygonPatch(drawTarget, draftPoints, previewConfig?.gatePolygons);
    }
  }), [drawTarget, draftPoints, previewConfig?.gatePolygons]);

  const queryConfig = useMemo(() => ({
    guardiaLat: previewConfig?.guardiaLat === '' ? null : Number(previewConfig?.guardiaLat),
    guardiaLng: previewConfig?.guardiaLng === '' ? null : Number(previewConfig?.guardiaLng),
    geofenceMode: previewConfig?.geofenceMode === 'polygon' ? 'polygon' : 'circle',
    gatePolygons: normalizeGatePolygons(previewConfig?.gatePolygons),
    plantPolygon: previewConfig?.plantPolygon || null,
    gateRadiusMeters: Number(previewConfig?.gateRadiusMeters ?? previewConfig?.alertRadiusMeters) || 45,
    plantRadiusMeters: Number(previewConfig?.plantRadiusMeters) || 400,
    minSpeedKnots: Number(previewConfig?.minSpeedKnots ?? 1),
    requireMotion: previewConfig?.requireMotion !== false,
    approachRadiusMeters: Number(previewConfig?.approachRadiusMeters) || 400,
    approachAlertEnabled: previewConfig?.approachAlertEnabled === true,
    pollIntervalSeconds: Math.max(15, Number(previewConfig?.pollIntervalSeconds) || 20)
  }), [previewConfig]);

  const hasCoords = !Number.isNaN(queryConfig.guardiaLat) && !Number.isNaN(queryConfig.guardiaLng);
  const polygonMode = queryConfig.geofenceMode === 'polygon';
  const isDrawing = editable && polygonMode && draftPoints.length > 0;

  useEffect(() => {
    mapViewLockedRef.current = isDrawing;
  }, [isDrawing]);

  const fetchLive = useCallback(async (silent = false) => {
    if (!authToken || !active) return;
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({
        gateRadiusMeters: String(queryConfig.gateRadiusMeters),
        plantRadiusMeters: String(queryConfig.plantRadiusMeters),
        minSpeedKnots: String(queryConfig.minSpeedKnots),
        requireMotion: String(queryConfig.requireMotion),
        geofenceMode: queryConfig.geofenceMode
      });
      if (hasCoords) {
        params.set('guardiaLat', String(queryConfig.guardiaLat));
        params.set('guardiaLng', String(queryConfig.guardiaLng));
      }
      if (polygonMode && !editable) {
        params.set('geofenceMode', 'polygon');
        params.set('gatePolygons', JSON.stringify(queryConfig.gatePolygons));
        if (queryConfig.plantPolygon) {
          params.set('plantPolygon', JSON.stringify(queryConfig.plantPolygon));
        }
      }
      const response = await fetch(`${API_BASE_URL}/admin/fleet-gps/live?${params.toString()}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'Error al cargar mapa');
      setSnapshot(data);
      setError(data.error || null);
    } catch (err) {
      setError(err.message || 'No se pudo cargar el mapa en vivo');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [authToken, active, hasCoords, queryConfig, editable]);

  useEffect(() => {
    if (!active || !authToken || isDrawing) return undefined;
    fetchLive(false);
    const timer = setInterval(() => {
      if (!mapViewLockedRef.current) fetchLive(true);
    }, queryConfig.pollIntervalSeconds * 1000);
    return () => clearInterval(timer);
  }, [active, authToken, fetchLive, queryConfig.pollIntervalSeconds, isDrawing]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return undefined;

    const map = L.map(mapContainerRef.current, {
      zoomControl: true,
      attributionControl: true
    });
    map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    mapRef.current = map;
    mapReadyRef.current = true;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    layersRef.current.markers = L.layerGroup().addTo(map);

    const resizeTimer = window.setTimeout(() => {
      map.invalidateSize();
    }, 150);

    return () => {
      window.clearTimeout(resizeTimer);
      map.remove();
      mapRef.current = null;
      mapReadyRef.current = false;
      fitKeyRef.current = '';
      layersRef.current = {
        gate: null,
        plant: null,
        approach: null,
        guardia: null,
        markers: null,
        polygons: [],
        draft: null
      };
    };
  }, []);

  useEffect(() => {
    if (!active || !mapRef.current) return undefined;
    const timer = window.setTimeout(() => {
      mapRef.current?.invalidateSize();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [active, polygonMode, editable]);

  const removeLayer = (map, key) => {
    if (layersRef.current[key]) {
      map.removeLayer(layersRef.current[key]);
      layersRef.current[key] = null;
    }
  };

  const fitMapToContent = useCallback((map, lat, lng, vehicles) => {
    if (mapViewLockedRef.current || !isValidCoord(lat, lng)) return;

    const center = [Number(lat), Number(lng)];
    const gateRadius = queryConfig.gateRadiusMeters;
    const plantRadius = queryConfig.plantRadiusMeters;
    const fitKey = `${lat},${lng},${polygonMode},${gateRadius},${plantRadius},${queryConfig.approachAlertEnabled}`;
    if (fitKeyRef.current === fitKey) return;

    fitKeyRef.current = fitKey;

    if (vehicles.length === 0) {
      map.setView(center, 16);
      return;
    }

    const bounds = L.latLngBounds([center]);
    vehicles.forEach((vehicle) => {
      if (vehicle.lat != null && vehicle.lng != null) bounds.extend([vehicle.lat, vehicle.lng]);
    });
    queryConfig.gatePolygons.forEach((gate) => {
      gate.points?.forEach((point) => bounds.extend(point));
    });
    queryConfig.plantPolygon?.points?.forEach((point) => bounds.extend(point));
    map.fitBounds(bounds.pad(0.12), { maxZoom: 17 });
  }, [polygonMode, queryConfig]);

  const renderGeofenceLayers = useCallback((map, lat, lng) => {
    const passthrough = editable;
    removeLayer(map, 'gate');
    removeLayer(map, 'plant');
    removeLayer(map, 'approach');
    layersRef.current.polygons.forEach((layer) => map.removeLayer(layer));
    layersRef.current.polygons = [];

    if (polygonMode) {
      queryConfig.gatePolygons.forEach((gate, index) => {
        if (!gate.points || gate.points.length < 3) return;
        const layer = L.polygon(gate.points, {
          color: index === 0 ? '#dc2626' : '#ea580c',
          weight: 2,
          fillColor: index === 0 ? '#dc2626' : '#ea580c',
          fillOpacity: 0.14,
          interactive: !passthrough
        }).bindPopup(`<strong>${gate.name}</strong><div>Zona de tr?nsito / port?n</div>`);
        layer.addTo(map);
        layersRef.current.polygons.push(layer);
      });

      if (queryConfig.plantPolygon?.points?.length >= 3) {
        const plantLayer = L.polygon(queryConfig.plantPolygon.points, {
          color: '#2563eb',
          weight: 2,
          fillColor: '#2563eb',
          fillOpacity: 0.06,
          dashArray: '8 6',
          interactive: !passthrough
        }).bindPopup('<strong>Planta</strong><div>Per?metro interno</div>');
        plantLayer.addTo(map);
        layersRef.current.polygons.push(plantLayer);
      }
    } else if (isValidCoord(lat, lng)) {
      const center = [Number(lat), Number(lng)];
      layersRef.current.plant = L.circle(center, {
        radius: queryConfig.plantRadiusMeters,
        color: '#2563eb',
        weight: 2,
        fillColor: '#2563eb',
        fillOpacity: 0.06,
        dashArray: '8 6',
        interactive: !passthrough
      }).addTo(map);

      layersRef.current.gate = L.circle(center, {
        radius: queryConfig.gateRadiusMeters,
        color: '#dc2626',
        weight: 2,
        fillColor: '#dc2626',
        fillOpacity: 0.1,
        dashArray: '4 4',
        interactive: !passthrough
      }).addTo(map);
    }

    if (queryConfig.approachAlertEnabled && isValidCoord(lat, lng)) {
      const center = [Number(lat), Number(lng)];
      layersRef.current.approach = L.circle(center, {
        radius: queryConfig.approachRadiusMeters,
        color: '#d97706',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.05,
        dashArray: '10 8',
        interactive: false
      }).bindPopup('<strong>Alerta de acercamiento</strong><div>M?viles en movimiento dentro de este radio avisan al guardia. Compatible con pol?gonos de port?n.</div>')
        .addTo(map);
    }

    if (isValidCoord(lat, lng)) {
      const center = [Number(lat), Number(lng)];
      removeLayer(map, 'guardia');
      layersRef.current.guardia = L.marker(center, {
        icon: guardiaIcon,
        interactive: !passthrough
      })
        .bindPopup('<strong>Referencia guardia</strong><div>Punto central de respaldo</div>')
        .addTo(map);
    }
  }, [polygonMode, queryConfig, editable]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;

    const lat = hasCoords ? queryConfig.guardiaLat : snapshot?.guardiaLat;
    const lng = hasCoords ? queryConfig.guardiaLng : snapshot?.guardiaLng;
    const vehicles = snapshot?.vehicles || [];

    const applyLayers = () => {
      renderGeofenceLayers(map, lat, lng);
      fitMapToContent(map, lat, lng, vehicles);
    };

    if (map._loaded) applyLayers();
    else map.whenReady(applyLayers);
  }, [snapshot?.vehicles, hasCoords, queryConfig, polygonMode, renderGeofenceLayers, fitMapToContent, snapshot?.guardiaLat, snapshot?.guardiaLng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;

    layersRef.current.markers?.clearLayers();
    const markersInteractive = !(editable && polygonMode);
    (snapshot?.vehicles || []).forEach((vehicle) => {
      if (vehicle.lat == null || vehicle.lng == null) return;
      const marker = L.marker([vehicle.lat, vehicle.lng], {
        icon: buildMarkerIcon(vehicle),
        interactive: markersInteractive
      });
      marker.bindPopup(buildPopupHtml(vehicle));
      layersRef.current.markers?.addLayer(marker);
    });
  }, [snapshot?.vehicles, editable, polygonMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;

    removeLayer(map, 'draft');

    if (editable && draftPoints.length >= 1) {
      if (draftPoints.length >= 2) {
        layersRef.current.draft = L.polygon(draftPoints, {
          color: '#f59e0b',
          weight: 2,
          fillColor: '#f59e0b',
          fillOpacity: 0.12,
          dashArray: '3 5',
          interactive: false
        }).addTo(map);
      } else {
        layersRef.current.draft = L.circleMarker(draftPoints[0], {
          radius: 6,
          color: '#f59e0b',
          fillColor: '#f59e0b',
          fillOpacity: 0.9,
          weight: 2,
          interactive: false
        }).addTo(map);
      }
    }
  }, [draftPoints, editable]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !editable || !polygonMode) return undefined;

    const handleClick = (event) => {
      setDraftPoints((prev) => [...prev, [event.latlng.lat, event.latlng.lng]]);
    };

    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [editable, polygonMode]);

  const updateGeofence = (patch) => {
    if (typeof onGeofenceChange === 'function') onGeofenceChange(patch);
  };

  const handleFinishPolygon = () => {
    const patch = buildGatePolygonPatch(drawTarget, draftPoints, queryConfig.gatePolygons);
    if (!patch) {
      setGeofenceMessage('Agreg? al menos 3 puntos para cerrar el pol?gono.');
      return;
    }
    updateGeofence(patch);
    setDraftPoints([]);
    const targetLabel = drawTarget === 'plant'
      ? 'Planta'
      : (GATE_TARGETS.find((gate) => gate.id === drawTarget)?.name || 'Port?n');
    setGeofenceMessage(`Pol?gono de ${targetLabel} listo en el mapa. Presion? ?Guardar cambios del mapa? para persistir.`);
  };

  const handleSaveGeofence = async () => {
    if (!authToken) return;
    setSavingGeofence(true);
    setGeofenceMessage('');
    try {
      const draftPatch = buildGatePolygonPatch(drawTarget, draftPoints, queryConfig.gatePolygons) || {};
      const gatePolygons = normalizeGatePolygonsForSave(
        draftPatch.gatePolygons || queryConfig.gatePolygons
      );
      const hasGate = gatePolygons.some((gate) => gate.points.length >= 3);
      if (queryConfig.geofenceMode === 'polygon' && !hasGate) {
        throw new Error('Dibuj? y cerr? al menos un port?n (3 puntos) antes de guardar.');
      }

      const body = {
        geofenceMode: draftPatch.geofenceMode || queryConfig.geofenceMode,
        gatePolygons,
        guardiaLat: queryConfig.guardiaLat,
        guardiaLng: queryConfig.guardiaLng
      };
      const plantPolygon = draftPatch.plantPolygon || queryConfig.plantPolygon;
      if (plantPolygon) body.plantPolygon = plantPolygon;

      const response = await fetch(`${API_BASE_URL}/admin/fleet-gps/geofence`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || data.message || 'Error al guardar geocercas');
      }

      const cfg = data.config || {};
      const patch = {
        geofenceMode: cfg.geofenceMode || body.geofenceMode,
        gatePolygons: normalizeGatePolygonsForSave(cfg.gatePolygons || gatePolygons),
        plantPolygon: cfg.plantPolygon ?? body.plantPolygon ?? null
      };
      updateGeofence(patch);
      if (draftPatch.gatePolygons || draftPatch.plantPolygon) {
        setDraftPoints([]);
      }
      setGeofenceMessage('Geocercas guardadas correctamente.');
      onGeofenceSaved?.(patch);
      fetchLive(true);
    } catch (err) {
      const message = err.message || 'Error al guardar geocercas del mapa';
      setGeofenceMessage(message);
      onGeofenceError?.(message);
    } finally {
      setSavingGeofence(false);
    }
  };

  const handleLoadTarget = (targetId) => {
    setDrawTarget(targetId);
    if (targetId === 'plant') {
      setDraftPoints(queryConfig.plantPolygon?.points || []);
      return;
    }
    const gate = queryConfig.gatePolygons.find((item) => item.id === targetId);
    setDraftPoints(gate?.points || []);
  };

  const handleClearTarget = () => {
    if (drawTarget === 'plant') {
      updateGeofence({ plantPolygon: null });
      setDraftPoints([]);
      return;
    }
    const nextGates = queryConfig.gatePolygons.map((gate) => (
      gate.id === drawTarget ? { ...gate, points: [] } : gate
    ));
    updateGeofence({ gatePolygons: nextGates });
    setDraftPoints([]);
  };

  const handleCenterMap = () => {
    const map = mapRef.current;
    const lat = hasCoords ? queryConfig.guardiaLat : snapshot?.guardiaLat;
    const lng = hasCoords ? queryConfig.guardiaLng : snapshot?.guardiaLng;
    if (!map || !isValidCoord(lat, lng)) return;
    mapViewLockedRef.current = false;
    fitKeyRef.current = '';
    fitMapToContent(map, lat, lng, snapshot?.vehicles || []);
  };

  const configuredGates = queryConfig.gatePolygons.filter((gate) => gate.points?.length >= 3).length;
  const hasPlantPolygon = queryConfig.plantPolygon?.points?.length >= 3;

  return (
    <div className="fleet-gps-live-map">
      <div className="fleet-gps-live-map__header">
        <div>
          <h4 className="theme-section-title" style={{ fontSize: '1.05rem', marginBottom: '0.25rem' }}>
            Mapa en vivo (solo admin)
          </h4>
          <p className="theme-section-desc" style={{ marginBottom: 0 }}>
            {polygonMode
              ? 'Dibuje pol?gonos sobre cada port?n para detectar entradas y salidas con precisi?n. Puede marcar hasta 2 portones y el per?metro de planta.'
              : 'Visualice cada cami?n y ajuste los radios de port?n/planta hasta que las entradas y salidas coincidan con la realidad.'}
          </p>
        </div>
        <div className="fleet-gps-live-map__header-actions">
          {editable && (
            <button
              type="button"
              className="btn btn-primary btn-secondary-small"
              onClick={handleSaveGeofence}
              disabled={savingGeofence || isDrawing}
            >
              {savingGeofence ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Guardar cambios del mapa
            </button>
          )}
          <button type="button" className="btn btn-secondary-small" onClick={handleCenterMap}>
            <MapPin size={14} /> Centrar mapa
          </button>
          <button type="button" className="btn btn-secondary-small" onClick={() => fetchLive(false)} disabled={loading || isDrawing}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Actualizar
          </button>
        </div>
      </div>

      {editable && (
        <div className="fleet-gps-geofence-editor">
          <div className="fleet-gps-geofence-editor__row">
            <label className="fleet-gps-geofence-editor__field">
              <span>Modo de geocerca</span>
              <select
                value={queryConfig.geofenceMode}
                onChange={(e) => updateGeofence({ geofenceMode: e.target.value })}
                className="input-field"
              >
                <option value="circle">C?rculos (r?pido)</option>
                <option value="polygon">Pol?gonos (portones)</option>
              </select>
            </label>
            {polygonMode && (
              <label className="fleet-gps-geofence-editor__field">
                <span>Dibujar zona</span>
                <select
                  value={drawTarget}
                  onChange={(e) => handleLoadTarget(e.target.value)}
                  className="input-field"
                >
                  {GATE_TARGETS.map((gate) => (
                    <option key={gate.id} value={gate.id}>{gate.name}</option>
                  ))}
                  <option value="plant">Planta</option>
                </select>
              </label>
            )}
          </div>

          {polygonMode && (
            <>
              <p className="fleet-gps-geofence-editor__hint">
                Hac? clic en el mapa para agregar v?rtices (Port?n Santiago / Port?n Olmos).
                La alerta de acercamiento a 400 m puede estar activa al mismo tiempo: avisa al guardia antes del cruce y el ingreso/egreso se registra al pasar el pol?gono del port?n.
              </p>
              <div className="fleet-gps-geofence-editor__actions">
                <button type="button" className="btn btn-secondary-small" onClick={handleFinishPolygon} disabled={draftPoints.length < 3}>
                  <Pentagon size={14} /> Cerrar pol?gono ({draftPoints.length} pts)
                </button>
                <button type="button" className="btn btn-secondary-small" onClick={() => setDraftPoints((prev) => prev.slice(0, -1))} disabled={!draftPoints.length}>
                  <Undo2 size={14} /> Deshacer punto
                </button>
                <button type="button" className="btn btn-secondary-small" onClick={handleClearTarget}>
                  <Trash2 size={14} /> Borrar zona actual
                </button>
              </div>
              <div className="fleet-gps-geofence-editor__status">
                <span>{configuredGates} port?n(es) configurado(s)</span>
                <span>{hasPlantPolygon ? 'Planta definida' : 'Planta sin pol?gono (usa radio)'}</span>
              </div>
            </>
          )}
        </div>
      )}

      {!hasCoords && (
        <div className="theme-callout-info">
          Complete latitud y longitud de la guardia arriba para centrar el mapa.
        </div>
      )}

      {geofenceMessage && (
        <div className={`theme-callout-${geofenceMessage.includes('Error') || geofenceMessage.includes('al menos') ? 'warn' : 'info'}`} style={{ marginBottom: '0.75rem' }}>
          {geofenceMessage}
        </div>
      )}

      {error && (
        <div className="theme-callout-warn" style={{ marginBottom: '0.75rem' }}>
          {error}
        </div>
      )}

      <div className="fleet-gps-live-map__meta">
        {polygonMode ? (
          <>
            <span><MapPin size={14} /> Modo pol?gonos</span>
            <span>{configuredGates} portones</span>
          </>
        ) : (
          <>
            <span><MapPin size={14} /> Port?n {queryConfig.gateRadiusMeters} m</span>
            <span>Planta {queryConfig.plantRadiusMeters} m</span>
          </>
        )}
        <span>{snapshot?.vehicleCount ?? 0} m?viles</span>
        {snapshot?.summary && (
          <>
            <span>{snapshot.summary.moving} en movimiento</span>
            <span>{snapshot.summary.stopped} detenidos</span>
            <span>{snapshot.summary.atGate} en port?n</span>
          </>
        )}
        {snapshot?.syncedAt && (
          <span className="fleet-gps-live-map__sync">Actualizado {formatFleetTime(snapshot.syncedAt)}</span>
        )}
      </div>

      <div className="fleet-gps-live-map__legend">
        <span><i style={{ background: '#dc2626' }} /> Port?n en movimiento</span>
        <span><i style={{ background: '#f97316' }} /> Port?n detenido</span>
        <span><i style={{ background: '#16a34a' }} /> Planta detenido</span>
        <span><i style={{ background: '#2563eb' }} /> Planta en movimiento</span>
        <span><i style={{ background: '#6b7280' }} /> Afuera detenido</span>
      </div>

      <div ref={mapContainerRef} className="fleet-gps-live-map__canvas" aria-label="Mapa GPS flota en vivo" />
    </div>
  );
});

export default FleetGpsLiveMap;
