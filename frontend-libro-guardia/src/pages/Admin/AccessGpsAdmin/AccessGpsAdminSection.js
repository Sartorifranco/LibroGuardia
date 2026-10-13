import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save, X } from 'lucide-react';
import FleetGpsVehicleTable, { formatFleetTime } from '../../../components/FleetGpsVehicleTable';
import { AdminEmpty, AdminLoading } from '../../../components/admin/AdminUi';
import { PageHeader, AdvancedSection, HelpTip } from '../../../components/admin-ui';
import { normalizeGatePolygonsForSave } from '../../../utils/fleetGpsGeofence';
import { hasPermission } from '../../../utils/permissions';
import { kmhToKnots, knotsToKmh } from '../../../utils/speedUnits';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';

const LazyFleetGpsLiveMap = forwardRef(function LazyFleetGpsLiveMap(props, ref) {
  const [MapView, setMapView] = useState(null);
  useEffect(() => {
    let cancelled = false;
    import('../../../components/FleetGpsLiveMap').then((mod) => {
      if (!cancelled) setMapView(() => mod.default);
    }).catch(() => {
      if (!cancelled) setMapView(null);
    });
    return () => { cancelled = true; };
  }, []);
  if (!MapView) return <p className="route-fallback" role="status">Cargando el mapa…</p>;
  return <MapView ref={ref} {...props} />;
});

function AccessGpsAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [speedKmh, setSpeedKmh] = useState(5);
  const [liveCount, setLiveCount] = useState(null);
  const [pendingDraw, setPendingDraw] = useState(null);
  const [fleetGpsConfig, setFleetGpsConfig] = useState({
    enabled: false,
    provider: 'ubika',
    apiUrl: 'https://ubika.rastreo.com.ar',
    apiKey: '',
    hasApiKey: false,
    guardiaLat: '',
    guardiaLng: '',
    geofenceMode: 'polygon',
    gatePolygons: [],
    plantPolygon: null,
    gateRadiusMeters: 45,
    plantRadiusMeters: 400,
    alertRadiusMeters: 45,
    minSpeedKnots: 1,
    requireMotion: true,
    autoRegisterMovements: true,
    movementCooldownSeconds: 300,
    pollIntervalSeconds: 60,
    cloudSyncIntervalMinutes: 5,
    approachAlertEnabled: true,
    approachRadiusMeters: 800,
    approachRequireMotion: true,
    lastError: null,
    lastSyncAt: null
  });
  const [fleetGpsTestResult, setFleetGpsTestResult] = useState(null);
  const [testOpen, setTestOpen] = useState(false);
  const fleetGpsMapRef = useRef(null);

  const onSnapshot = useCallback((snap) => {
    if (snap && snap.vehicleCount != null) setLiveCount(Number(snap.vehicleCount) || 0);
  }, []);

  useEffect(() => {
    const fetchFleetGps = async () => {
      if (!currentUser || !hasPermission(currentUser, 'access.control')) return;
      setLoading(true);
      setLoadError(null);
      try {
        const data = await apiFetch('/admin/fleet-gps', { token: authToken, allowForbidden: true });
        const cfg = data.config || {};
        setFleetGpsConfig((prev) => ({
          ...prev,
          ...cfg,
          geofenceMode: cfg.geofenceMode || 'polygon',
          gatePolygons: normalizeGatePolygonsForSave(cfg.gatePolygons || prev.gatePolygons || []),
          plantPolygon: cfg.plantPolygon ?? prev.plantPolygon ?? null,
          guardiaLat: cfg.guardiaLat ?? '',
          guardiaLng: cfg.guardiaLng ?? '',
          apiKey: cfg.hasApiKey ? '********' : '',
          approachRadiusMeters: cfg.approachRadiusMeters ?? 800
        }));
        setSpeedKmh(knotsToKmh(cfg.minSpeedKnots ?? kmhToKnots(5)));
      } catch (err) {
        setLoadError(err.message || 'No se pudo cargar el mapa de vehículos');
        showError(err.message || 'No se pudo cargar el mapa de vehículos');
      } finally {
        setLoading(false);
      }
    };
    fetchFleetGps();
  }, [currentUser, authToken, showError]);

  useEffect(() => {
    if (!pendingDraw) return;
    fleetGpsMapRef.current?.startDraw(pendingDraw);
  }, [pendingDraw, fleetGpsConfig.geofenceMode]);

  const vehicleCount = liveCount ?? fleetGpsTestResult?.vehicleCount ?? null;
  const connected = Boolean(fleetGpsConfig.enabled && fleetGpsConfig.hasApiKey && !fleetGpsConfig.lastError);
  const statusText = connected
    ? `Conectado: ${vehicleCount == null ? '…' : vehicleCount} vehículos visibles`
    : 'Sin conexión';

  const startDraw = (target) => {
    setFleetGpsConfig((prev) => ({ ...prev, geofenceMode: 'polygon' }));
    setPendingDraw(target);
  };

  const handleSaveFleetGps = async (e) => {
    e?.preventDefault?.();
    await runAction('saveFleetGps', async () => {
      try {
        const configToSave = {
          ...fleetGpsConfig,
          gatePolygons: normalizeGatePolygonsForSave(fleetGpsConfig.gatePolygons || [])
        };
        const approachMeters = Number(configToSave.approachRadiusMeters) || 0;
        const saveBody = {
          enabled: configToSave.enabled,
          provider: 'ubika',
          apiUrl: configToSave.apiUrl,
          apiKey: configToSave.apiKey,
          guardiaLat: configToSave.guardiaLat === '' ? null : Number(configToSave.guardiaLat),
          guardiaLng: configToSave.guardiaLng === '' ? null : Number(configToSave.guardiaLng),
          gateRadiusMeters: Number(configToSave.gateRadiusMeters) || 45,
          plantRadiusMeters: Number(configToSave.plantRadiusMeters) || 400,
          alertRadiusMeters: Number(configToSave.gateRadiusMeters) || 45,
          minSpeedKnots: kmhToKnots(speedKmh),
          requireMotion: Number(speedKmh) > 0,
          autoRegisterMovements: configToSave.autoRegisterMovements !== false,
          movementCooldownSeconds: Number(configToSave.movementCooldownSeconds) || 300,
          pollIntervalSeconds: Number(configToSave.pollIntervalSeconds) || 60,
          cloudSyncIntervalMinutes: Number(configToSave.cloudSyncIntervalMinutes) || 5,
          approachAlertEnabled: approachMeters > 0,
          approachRadiusMeters: approachMeters || 800,
          approachRequireMotion: Number(speedKmh) > 0
        };

        const data = await apiFetch('/admin/fleet-gps', {
          method: 'PUT',
          token: authToken,
          body: saveBody
        });
        const cfg = data.config || {};
        setFleetGpsConfig((prev) => ({
          ...prev,
          ...cfg,
          geofenceMode: cfg.geofenceMode || configToSave.geofenceMode || 'polygon',
          gatePolygons: normalizeGatePolygonsForSave(cfg.gatePolygons || configToSave.gatePolygons || []),
          plantPolygon: cfg.plantPolygon ?? configToSave.plantPolygon ?? prev.plantPolygon ?? null,
          guardiaLat: cfg.guardiaLat ?? '',
          guardiaLng: cfg.guardiaLng ?? '',
          apiKey: cfg.hasApiKey ? '********' : ''
        }));
        if (cfg.minSpeedKnots != null) setSpeedKmh(knotsToKmh(cfg.minSpeedKnots));
        showSuccess('Reglas del mapa guardadas. El dibujo del portón se guarda con el botón del mapa.');
      } catch (err) {
        showError(err.message || 'No se pudieron guardar las reglas');
      }
    });
  };

  const handleTestFleetGps = async () => {
    await runAction('testFleetGps', async () => {
      try {
        const data = await apiFetch('/admin/fleet-gps/test', { method: 'POST', token: authToken });
        setFleetGpsTestResult(data);
        if (data.vehicleCount != null) setLiveCount(Number(data.vehicleCount) || 0);
        setTestOpen(true);
        if (data.error) showError(data.error);
        else showSuccess(data.message || 'Conexión lista');
      } catch (err) {
        setFleetGpsTestResult(null);
        setTestOpen(false);
        showError(err.message || 'No se pudo probar la conexión');
      }
    });
  };

  const gatesDrawn = useMemo(
    () => (fleetGpsConfig.gatePolygons || []).filter((g) => (g.points || []).length >= 3).length,
    [fleetGpsConfig.gatePolygons]
  );
  const plantDrawn = (fleetGpsConfig.plantPolygon?.points || []).length >= 3;

  if (!hasPermission(currentUser, 'access.control')) return null;
  if (loading) return <AdminLoading label="Cargando el mapa de vehículos…" />;
  if (loadError) {
    return (
      <AdminEmpty
        title="No se pudo cargar el mapa"
        description={loadError}
      />
    );
  }

  return (
    <div className="access-gps-admin admin-simple">
      <PageHeader
        title="GPS de vehículos"
        purpose="El mapa marca el portón y la planta para saber cuándo un vehículo entra o sale."
        howTo={[
          'Dibujá el portón y la planta sobre el mapa.',
          'Ajustá a qué velocidad y a qué distancia se avisa.',
          'Guardá. El dibujo se guarda aparte, en el mapa.'
        ]}
        action={(
          <button type="button" className="btn btn-primary" onClick={handleSaveFleetGps}>
            <Save size={16} />
            Guardar
          </button>
        )}
      />

      <p className={`admin-simple-status${connected ? '' : ''}`} role="status">
        {statusText}
        {gatesDrawn ? ` · Portón dibujado` : ''}
        {plantDrawn ? ' · Planta dibujada' : ''}
      </p>

      <div className="admin-simple-choice" style={{ marginBottom: '0.75rem' }}>
        <button type="button" className="btn btn-secondary admin-simple-touch" onClick={() => startDraw('gate-1')}>
          Dibujá el portón
        </button>
        <button type="button" className="btn btn-secondary admin-simple-touch" onClick={() => startDraw('plant')}>
          Dibujá la planta
        </button>
        <button type="button" className="btn btn-secondary admin-simple-touch" onClick={handleTestFleetGps}>
          Probar conexión
        </button>
      </div>

      <label className="admin-simple-sentence" style={{ marginBottom: '0.75rem' }}>
        <input
          type="checkbox"
          checked={Boolean(fleetGpsConfig.enabled)}
          onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
        />
        Usar el mapa en la pantalla del guardia
      </label>

      <LazyFleetGpsLiveMap
        ref={fleetGpsMapRef}
        authToken={authToken}
        previewConfig={fleetGpsConfig}
        active
        editable
        simpleMode
        onSnapshot={onSnapshot}
        onGeofenceChange={(patch) => setFleetGpsConfig((prev) => ({ ...prev, ...patch }))}
        onGeofenceSaved={() => showSuccess('Dibujo del mapa guardado.')}
        onGeofenceError={(message) => showError(message)}
      />

      <h3 className="admin-block__title" style={{ marginTop: '1.25rem' }}>Reglas</h3>
      <p className="admin-simple-sentence">
        Ignorar vehículos que van a menos de
        <input
          className="input-field"
          aria-label="Velocidad mínima en kilómetros por hora"
          type="number"
          min="0"
          max="40"
          step="0.5"
          value={speedKmh}
          onChange={(e) => setSpeedKmh(e.target.value)}
        />
        km/h
        <HelpTip text="Así no se anota un vehículo que está estacionado o apenas se mueve." />
      </p>
      <p className="admin-simple-sentence">
        Avisar al guardia cuando un vehículo está a
        <input
          className="input-field"
          aria-label="Distancia de aviso en metros"
          type="number"
          min="0"
          max="3000"
          value={fleetGpsConfig.approachRadiusMeters ?? 800}
          onChange={(e) => setFleetGpsConfig((prev) => ({
            ...prev,
            approachRadiusMeters: Number(e.target.value)
          }))}
        />
        metros del portón
        <HelpTip text="El aviso llega antes de que el vehículo cruce. El ingreso se anota al pasar el portón. 0 apaga el aviso." />
      </p>
      <label className="admin-simple-sentence">
        Registrar ingresos y egresos automáticamente
        <select
          className="input-field"
          aria-label="Registrar ingresos y egresos automáticamente"
          style={{ width: 'auto', minHeight: 44 }}
          value={fleetGpsConfig.autoRegisterMovements !== false ? 'si' : 'no'}
          onChange={(e) => setFleetGpsConfig((prev) => ({
            ...prev,
            autoRegisterMovements: e.target.value === 'si'
          }))}
        >
          <option value="si">Sí</option>
          <option value="no">No</option>
        </select>
      </label>

      <AdvancedSection title="Opciones avanzadas">
        <p className="historial-meta">Datos para el instalador. No hace falta tocarlos el primer día.</p>
        <label className="field-label">
          URL del proveedor
          <input
            className="input-field"
            aria-label="URL del proveedor"
            value={fleetGpsConfig.apiUrl}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiUrl: e.target.value }))}
          />
        </label>
        <label className="field-label">
          Token
          <input
            className="input-field"
            type="password"
            aria-label="Token"
            value={fleetGpsConfig.apiKey}
            placeholder={fleetGpsConfig.hasApiKey ? 'Ya hay una clave guardada' : 'Clave del proveedor'}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
            autoComplete="off"
          />
        </label>
        <label className="field-label">
          Consultar posiciones cada (minutos)
          <input
            className="input-field"
            aria-label="Frecuencia de consulta en minutos"
            type="number"
            min="2"
            max="30"
            value={fleetGpsConfig.cloudSyncIntervalMinutes ?? 5}
            onChange={(e) => setFleetGpsConfig((prev) => ({
              ...prev,
              cloudSyncIntervalMinutes: Number(e.target.value)
            }))}
          />
        </label>
        <label className="field-label">
          Actualizar la pantalla cada (segundos)
          <input
            className="input-field"
            aria-label="Segundos entre actualizaciones de pantalla"
            type="number"
            min="30"
            max="300"
            value={fleetGpsConfig.pollIntervalSeconds}
            onChange={(e) => setFleetGpsConfig((prev) => ({
              ...prev,
              pollIntervalSeconds: Number(e.target.value)
            }))}
          />
        </label>
        <label className="field-label">
          Latitud
          <HelpTip text="Solo si el mapa no centra solo. Es un número, por ejemplo -31.42." />
          <input
            className="input-field"
            aria-label="Latitud"
            type="number"
            step="any"
            value={fleetGpsConfig.guardiaLat}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLat: e.target.value }))}
          />
        </label>
        <label className="field-label">
          Longitud
          <input
            className="input-field"
            aria-label="Longitud"
            type="number"
            step="any"
            value={fleetGpsConfig.guardiaLng}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLng: e.target.value }))}
          />
        </label>
        <label className="field-label">
          Esperar entre dos registros del mismo vehículo (segundos)
          <input
            className="input-field"
            type="number"
            min="60"
            max="3600"
            value={fleetGpsConfig.movementCooldownSeconds ?? 300}
            onChange={(e) => setFleetGpsConfig((prev) => ({
              ...prev,
              movementCooldownSeconds: Number(e.target.value)
            }))}
          />
        </label>
        {fleetGpsConfig.lastError ? (
          <p className="access-gps-admin__error">Último problema de conexión: {fleetGpsConfig.lastError}</p>
        ) : null}
      </AdvancedSection>

      {testOpen && fleetGpsTestResult && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onClick={() => setTestOpen(false)}>
          <div
            className="admin-modal admin-modal--wide access-gps-admin__test-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Resultado de la conexión"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="access-gps-admin__modal-head">
              <div>
                <h3 className="admin-modal-title">Resultado de la conexión</h3>
                <p className="theme-section-desc">
                  {fleetGpsTestResult.error || fleetGpsTestResult.message || statusText}
                </p>
              </div>
              <button type="button" className="estaciones-admin__icon-btn" onClick={() => setTestOpen(false)} aria-label="Cerrar">
                <X size={16} />
              </button>
            </header>
            <div className="fleet-gps-summary">
              <div className="fleet-gps-summary__card">
                <span className="fleet-gps-summary__label">Vehículos visibles</span>
                <span className="fleet-gps-summary__value">{fleetGpsTestResult.vehicleCount ?? '—'}</span>
              </div>
              <div className="fleet-gps-summary__card">
                <span className="fleet-gps-summary__label">En el portón</span>
                <span className="fleet-gps-summary__value">{(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length}</span>
              </div>
            </div>
            {(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length > 0 ? (
              <FleetGpsVehicleTable
                vehicles={(fleetGpsTestResult.transit || fleetGpsTestResult.alerts).map((item) => ({
                  ...item,
                  name: `${item.directionLabel || item.direction || ''}: ${item.name}`
                }))}
                radiusMeters={Number(fleetGpsConfig.gateRadiusMeters) || 45}
              />
            ) : (
              <FleetGpsVehicleTable
                vehicles={fleetGpsTestResult.nearest || []}
                radiusMeters={Number(fleetGpsConfig.gateRadiusMeters) || 45}
                emptyMessage="No llegaron posiciones de vehículos"
              />
            )}
            {fleetGpsTestResult.config?.lastSyncAt ? (
              <p className="historial-meta">Última actualización {formatFleetTime(fleetGpsTestResult.config.lastSyncAt)}</p>
            ) : null}
            <div className="estaciones-admin__modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setTestOpen(false)}>Cerrar</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default AccessGpsAdminSection;
