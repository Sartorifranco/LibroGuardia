import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save, ShieldCheck, Satellite, X } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import FleetGpsVehicleTable, { formatFleetTime } from '../../../components/FleetGpsVehicleTable';
import FleetGpsLiveMap from '../../../components/FleetGpsLiveMap';
import {
  AdminBlock,
  AdminEmpty,
  AdminFormCard,
  AdminLoading
} from '../../../components/admin/AdminUi';
import { normalizeGatePolygonsForSave } from '../../../utils/fleetGpsGeofence';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';

/**
 * Sección "GPS flota" (UBIKA) del panel de administración. El id de sección permanece 'access'.
 * @param {{ pendingAction: string|null, runAction: Function }} props
 */
function AccessGpsAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [fleetGpsConfig, setFleetGpsConfig] = useState({
    enabled: false,
    provider: 'ubika',
    apiUrl: 'https://ubika.rastreo.com.ar',
    apiKey: '',
    hasApiKey: false,
    guardiaLat: '',
    guardiaLng: '',
    geofenceMode: 'circle',
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
    approachAlertEnabled: false,
    approachRadiusMeters: 400,
    approachRequireMotion: true,
    lastError: null,
    lastSyncAt: null
  });
  const [fleetGpsTestResult, setFleetGpsTestResult] = useState(null);
  const [testOpen, setTestOpen] = useState(false);
  const fleetGpsMapRef = useRef(null);

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
          geofenceMode: cfg.geofenceMode || prev.geofenceMode || 'circle',
          gatePolygons: normalizeGatePolygonsForSave(cfg.gatePolygons || prev.gatePolygons || []),
          plantPolygon: cfg.plantPolygon ?? prev.plantPolygon ?? null,
          guardiaLat: cfg.guardiaLat ?? '',
          guardiaLng: cfg.guardiaLng ?? '',
          apiKey: cfg.hasApiKey ? '********' : ''
        }));
      } catch (err) {
        setLoadError(err.message || 'No se pudo cargar la configuración GPS');
        showError(err.message || 'No se pudo cargar GPS flota');
      } finally {
        setLoading(false);
      }
    };
    fetchFleetGps();
  }, [currentUser, authToken, showError]);

  const stats = useMemo(() => {
    const gates = (fleetGpsConfig.gatePolygons || []).filter((g) => (g.points || []).length >= 3).length;
    const plantOk = (fleetGpsConfig.plantPolygon?.points || []).length >= 3;
    return {
      enabled: Boolean(fleetGpsConfig.enabled),
      mode: fleetGpsConfig.geofenceMode === 'polygon' ? 'Polígonos' : 'Círculos',
      gates,
      plantOk,
      hasToken: Boolean(fleetGpsConfig.hasApiKey),
      lastSyncAt: fleetGpsConfig.lastSyncAt,
      lastError: fleetGpsConfig.lastError
    };
  }, [fleetGpsConfig]);

  const handleSaveFleetGps = async (e) => {
    e.preventDefault();
    await runAction('saveFleetGps', async () => {
      try {
        const configToSave = {
          ...fleetGpsConfig,
          gatePolygons: normalizeGatePolygonsForSave(fleetGpsConfig.gatePolygons || [])
        };

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
          minSpeedKnots: Number(configToSave.minSpeedKnots) || 0,
          requireMotion: configToSave.requireMotion !== false,
          autoRegisterMovements: configToSave.autoRegisterMovements !== false,
          movementCooldownSeconds: Number(configToSave.movementCooldownSeconds) || 300,
          pollIntervalSeconds: Number(configToSave.pollIntervalSeconds) || 60,
          cloudSyncIntervalMinutes: Number(configToSave.cloudSyncIntervalMinutes) || 5,
          approachAlertEnabled: configToSave.approachAlertEnabled === true,
          approachRadiusMeters: Number(configToSave.approachRadiusMeters) || 400,
          approachRequireMotion: configToSave.approachRequireMotion !== false
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
          geofenceMode: cfg.geofenceMode || configToSave.geofenceMode || 'circle',
          gatePolygons: normalizeGatePolygonsForSave(cfg.gatePolygons || configToSave.gatePolygons || []),
          plantPolygon: cfg.plantPolygon ?? configToSave.plantPolygon ?? prev.plantPolygon ?? null,
          guardiaLat: cfg.guardiaLat ?? '',
          guardiaLng: cfg.guardiaLng ?? '',
          apiKey: cfg.hasApiKey ? '********' : ''
        }));
        showSuccess('Configuración GPS UBIKA guardada. Las geocercas del mapa se guardan aparte.');
      } catch (err) {
        showError(err.message || 'Error al guardar GPS UBIKA');
      }
    });
  };

  const handleTestFleetGps = async () => {
    await runAction('testFleetGps', async () => {
      try {
        const data = await apiFetch('/admin/fleet-gps/test', {
          method: 'POST',
          token: authToken
        });
        setFleetGpsTestResult(data);
        setTestOpen(true);
        if (data.error) {
          showError(data.error);
        } else {
          showSuccess(data.message || 'Conexión UBIKA OK');
        }
      } catch (err) {
        setFleetGpsTestResult(null);
        setTestOpen(false);
        showError(err.message || 'Error al probar GPS UBIKA');
      }
    });
  };

  if (!hasPermission(currentUser, 'access.control')) return null;

  if (loading) {
    return <AdminLoading label="Cargando GPS flota…" />;
  }

  if (loadError) {
    return (
      <AdminEmpty
        icon={Satellite}
        title="No se pudo cargar GPS flota"
        description={loadError}
      />
    );
  }

  return (
    <div className="access-gps-admin">
      <div className="access-gps-admin__stats" aria-label="Resumen GPS flota">
        <div className={`access-gps-admin__stat${stats.enabled ? ' access-gps-admin__stat--ok' : ' access-gps-admin__stat--off'}`}>
          <span className="access-gps-admin__stat-label">Monitoreo</span>
          <strong className="access-gps-admin__stat-value">{stats.enabled ? 'Activo' : 'Apagado'}</strong>
        </div>
        <div className="access-gps-admin__stat">
          <span className="access-gps-admin__stat-label">Geocerca</span>
          <strong className="access-gps-admin__stat-value">{stats.mode}</strong>
        </div>
        <div className="access-gps-admin__stat">
          <span className="access-gps-admin__stat-label">Portones</span>
          <strong className="access-gps-admin__stat-value">{stats.gates}</strong>
        </div>
        <div className={`access-gps-admin__stat${stats.plantOk ? ' access-gps-admin__stat--ok' : ''}`}>
          <span className="access-gps-admin__stat-label">Planta</span>
          <strong className="access-gps-admin__stat-value">{stats.plantOk ? 'Polígono' : 'Por radio'}</strong>
        </div>
        <div className={`access-gps-admin__stat${stats.hasToken ? ' access-gps-admin__stat--ok' : ' access-gps-admin__stat--warn'}`}>
          <span className="access-gps-admin__stat-label">Token</span>
          <strong className="access-gps-admin__stat-value">{stats.hasToken ? 'OK' : 'Falta'}</strong>
        </div>
        {stats.lastSyncAt && (
          <div className="access-gps-admin__stat access-gps-admin__stat--wide">
            <span className="access-gps-admin__stat-label">Última sync</span>
            <strong className="access-gps-admin__stat-value">{formatFleetTime(stats.lastSyncAt)}</strong>
          </div>
        )}
        {stats.lastError && (
          <div className="access-gps-admin__stat access-gps-admin__stat--warn access-gps-admin__stat--wide" title={stats.lastError}>
            <span className="access-gps-admin__stat-label">Estado</span>
            <strong className="access-gps-admin__stat-value">Último error</strong>
          </div>
        )}
      </div>

      <AdminBlock
        title="Conexión y reglas"
        description="Detecta tránsito en el portón (entrando/saliendo), no los móviles estacionados en planta."
        action={(
          <div className="access-gps-admin__block-actions">
            <PendingButton
              type="button"
              actionId="testFleetGps"
              pendingAction={pendingAction}
              className="btn btn-secondary"
              pendingLabel="Probando…"
              onClick={handleTestFleetGps}
            >
              <ShieldCheck size={16} />
              Probar conexión
            </PendingButton>
          </div>
        )}
      >
        <AdminFormCard onSubmit={handleSaveFleetGps} className="access-gps-admin__form">
          <div className="access-gps-admin__toggles">
            <label className="access-gps-admin__check">
              <input
                type="checkbox"
                checked={Boolean(fleetGpsConfig.enabled)}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              Habilitar monitoreo GPS en panel del guardia
            </label>
            <label className="access-gps-admin__check">
              <input
                type="checkbox"
                checked={fleetGpsConfig.autoRegisterMovements !== false}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, autoRegisterMovements: e.target.checked }))}
              />
              Registrar automáticamente ingresos/egresos en el libro
            </label>
            <label className="access-gps-admin__check">
              <input
                type="checkbox"
                checked={fleetGpsConfig.requireMotion !== false}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, requireMotion: e.target.checked }))}
              />
              Solo contar móviles en movimiento
            </label>
            <label className="access-gps-admin__check">
              <input
                type="checkbox"
                checked={fleetGpsConfig.approachAlertEnabled === true}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, approachAlertEnabled: e.target.checked }))}
              />
              Alerta de acercamiento a planta (compatible con polígonos de portón)
            </label>
          </div>

          <div className="access-gps-admin__grid">
            <label className="access-gps-admin__field">
              <span>Latitud guardia</span>
              <input
                type="number"
                step="any"
                value={fleetGpsConfig.guardiaLat}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLat: e.target.value }))}
                className="input-field"
                placeholder="-31.420000"
                required={fleetGpsConfig.enabled}
              />
            </label>
            <label className="access-gps-admin__field">
              <span>Longitud guardia</span>
              <input
                type="number"
                step="any"
                value={fleetGpsConfig.guardiaLng}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLng: e.target.value }))}
                className="input-field"
                placeholder="-64.180000"
                required={fleetGpsConfig.enabled}
              />
            </label>
            <label className="access-gps-admin__field">
              <span>Radio portón (m)</span>
              <input
                type="number"
                min="15"
                max="120"
                value={fleetGpsConfig.gateRadiusMeters ?? fleetGpsConfig.alertRadiusMeters ?? 45}
                onChange={(e) => setFleetGpsConfig((prev) => ({
                  ...prev,
                  gateRadiusMeters: Number(e.target.value),
                  alertRadiusMeters: Number(e.target.value)
                }))}
                className="input-field"
                disabled={fleetGpsConfig.geofenceMode === 'polygon'}
              />
              <small>
                {fleetGpsConfig.geofenceMode === 'polygon'
                  ? 'En modo polígonos se usa el dibujo del mapa.'
                  : 'Zona de tránsito. Recomendado 35–50 m.'}
              </small>
            </label>
            <label className="access-gps-admin__field">
              <span>Radio planta (m)</span>
              <input
                type="number"
                min="80"
                max="2000"
                value={fleetGpsConfig.plantRadiusMeters ?? 400}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, plantRadiusMeters: Number(e.target.value) }))}
                className="input-field"
              />
              <small>Respaldo si no hay polígono de planta.</small>
            </label>
            <label className="access-gps-admin__field">
              <span>Radio alerta llegada (m)</span>
              <input
                type="number"
                min="100"
                max="3000"
                value={fleetGpsConfig.approachRadiusMeters ?? 400}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, approachRadiusMeters: Number(e.target.value) }))}
                className="input-field"
                disabled={!fleetGpsConfig.approachAlertEnabled}
              />
              <small>Avisa antes del cruce; el registro ocurre al pasar el portón.</small>
            </label>
            <label className="access-gps-admin__field">
              <span>Velocidad mínima (nudos)</span>
              <input
                type="number"
                min="0"
                max="20"
                step="0.5"
                value={fleetGpsConfig.minSpeedKnots ?? 1}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, minSpeedKnots: Number(e.target.value) }))}
                className="input-field"
              />
            </label>
            <label className="access-gps-admin__field">
              <span>Espera entre registros (seg)</span>
              <input
                type="number"
                min="60"
                max="3600"
                value={fleetGpsConfig.movementCooldownSeconds ?? 300}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, movementCooldownSeconds: Number(e.target.value) }))}
                className="input-field"
              />
            </label>
            <label className="access-gps-admin__field">
              <span>Actualizar pantalla cada (seg)</span>
              <input
                type="number"
                min="30"
                max="300"
                value={fleetGpsConfig.pollIntervalSeconds}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, pollIntervalSeconds: Number(e.target.value) }))}
                className="input-field"
              />
              <small>Solo refresca lo que ya está guardado. No consulta UBIKA.</small>
            </label>
            <label className="access-gps-admin__field">
              <span>Consulta UBIKA cada (min)</span>
              <input
                type="number"
                min="2"
                max="30"
                value={fleetGpsConfig.cloudSyncIntervalMinutes ?? 5}
                onChange={(e) => setFleetGpsConfig((prev) => ({
                  ...prev,
                  cloudSyncIntervalMinutes: Number(e.target.value)
                }))}
                className="input-field"
              />
              <small>
                Es el costo real. Cada 5 min alcanza para registrar el portón.
                El servidor ya corre cada 5 min; este valor marca cuánto tiempo vale la foto guardada.
              </small>
            </label>
            <label className="access-gps-admin__field">
              <span>URL API UBIKA</span>
              <input
                type="text"
                value={fleetGpsConfig.apiUrl}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiUrl: e.target.value }))}
                className="input-field"
                placeholder="https://ubika.rastreo.com.ar"
              />
            </label>
            <label className="access-gps-admin__field">
              <span>Token API</span>
              <input
                type="password"
                value={fleetGpsConfig.apiKey}
                onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
                className="input-field"
                placeholder={fleetGpsConfig.hasApiKey ? 'Token configurado' : 'Bearer token'}
                autoComplete="off"
              />
            </label>
          </div>

          {stats.lastError && (
            <p className="access-gps-admin__error">Último error de sync: {stats.lastError}</p>
          )}

          <div className="access-gps-admin__form-footer">
            <p className="access-gps-admin__hint">
              Este guardado es de conexión y reglas. Las geocercas se guardan en el mapa.
            </p>
            <PendingButton
              type="submit"
              actionId="saveFleetGps"
              pendingAction={pendingAction}
              className="btn btn-primary"
              pendingLabel="Guardando…"
            >
              <Save size={16} />
              Guardar configuración
            </PendingButton>
          </div>
        </AdminFormCard>
      </AdminBlock>

      <AdminBlock
        title="Mapa y geocercas"
        description="Dibujá portones o ajustá radios. Guardá los cambios del mapa con el botón del propio mapa."
      >
        <FleetGpsLiveMap
          ref={fleetGpsMapRef}
          authToken={authToken}
          previewConfig={fleetGpsConfig}
          active
          editable
          onGeofenceChange={(patch) => setFleetGpsConfig((prev) => ({ ...prev, ...patch }))}
          onGeofenceSaved={() => showSuccess('Geocercas del mapa guardadas.')}
          onGeofenceError={(message) => showError(message)}
        />
      </AdminBlock>

      {testOpen && fleetGpsTestResult && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onClick={() => setTestOpen(false)}>
          <div
            className="admin-modal admin-modal--wide access-gps-admin__test-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Resultado prueba UBIKA"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="access-gps-admin__modal-head">
              <div>
                <h3 className="admin-modal-title">Resultado de conexión</h3>
                <p className="theme-section-desc">
                  {fleetGpsTestResult.error || fleetGpsTestResult.message || 'Prueba UBIKA'}
                </p>
              </div>
              <button
                type="button"
                className="estaciones-admin__icon-btn"
                onClick={() => setTestOpen(false)}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="fleet-gps-summary">
              <div className="fleet-gps-summary__card">
                <span className="fleet-gps-summary__label">Flota total</span>
                <span className="fleet-gps-summary__value">{fleetGpsTestResult.vehicleCount ?? '—'}</span>
              </div>
              <div className={`fleet-gps-summary__card${(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length ? ' fleet-gps-summary__card--alert' : ''}`}>
                <span className="fleet-gps-summary__label">En tránsito</span>
                <span className="fleet-gps-summary__value">{(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length}</span>
              </div>
              <div className="fleet-gps-summary__card">
                <span className="fleet-gps-summary__label">En planta quietos</span>
                <span className="fleet-gps-summary__value">{(fleetGpsTestResult.inPlant || []).length}</span>
              </div>
              <div className="fleet-gps-summary__card fleet-gps-summary__card--wide">
                <span className="fleet-gps-summary__label">Radios</span>
                <span className="fleet-gps-summary__text">
                  Portón {fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters || 45} m
                  {' · '}
                  Planta {fleetGpsTestResult.plantRadiusMeters || fleetGpsConfig.plantRadiusMeters || 400} m
                </span>
                {fleetGpsTestResult.config?.lastSyncAt && (
                  <span className="fleet-gps-summary__meta">
                    Sync {formatFleetTime(fleetGpsTestResult.config.lastSyncAt)}
                  </span>
                )}
              </div>
            </div>

            {(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length > 0 ? (
              <>
                <h4 className="fleet-gps-section-title">Tránsito en portón</h4>
                <FleetGpsVehicleTable
                  vehicles={(fleetGpsTestResult.transit || fleetGpsTestResult.alerts).map((item) => ({
                    ...item,
                    name: `${item.directionLabel || item.direction || ''}: ${item.name}`
                  }))}
                  radiusMeters={Number(fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters) || 45}
                />
              </>
            ) : (
              <>
                <h4 className="fleet-gps-section-title">Más cercanos al portón</h4>
                <FleetGpsVehicleTable
                  vehicles={fleetGpsTestResult.nearest || []}
                  radiusMeters={Number(fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters) || 45}
                  emptyMessage="No se obtuvieron posiciones de la flota"
                />
              </>
            )}

            <div className="estaciones-admin__modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setTestOpen(false)}>
                Cerrar
              </button>
              <PendingButton
                type="button"
                actionId="testFleetGps"
                pendingAction={pendingAction}
                className="btn btn-primary"
                pendingLabel="Probando…"
                onClick={handleTestFleetGps}
              >
                <ShieldCheck size={16} />
                Probar de nuevo
              </PendingButton>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default AccessGpsAdminSection;
