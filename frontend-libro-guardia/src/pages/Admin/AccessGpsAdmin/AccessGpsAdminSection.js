import React, { useEffect, useRef, useState } from 'react';
import { Save, ShieldCheck, Loader2 } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import FleetGpsVehicleTable, { formatFleetTime } from '../../../components/FleetGpsVehicleTable';
import FleetGpsLiveMap from '../../../components/FleetGpsLiveMap';
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

  const [loading, setLoading] = useState(false);
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
    pollIntervalSeconds: 20,
    approachAlertEnabled: false,
    approachRadiusMeters: 400,
    approachRequireMotion: true,
    lastError: null,
    lastSyncAt: null
  });
  const [fleetGpsTestResult, setFleetGpsTestResult] = useState(null);
  const fleetGpsMapRef = useRef(null);

  useEffect(() => {
    const fetchFleetGps = async () => {
      if (!currentUser || !hasPermission(currentUser, 'access.control')) return;
      setLoading(true);
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
        console.error('Error al cargar GPS flota:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchFleetGps();
  }, [currentUser, authToken]);

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
          pollIntervalSeconds: Number(configToSave.pollIntervalSeconds) || 20,
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
        showSuccess('Configuración GPS UBIKA guardada.');
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
        if (data.error) {
          showError(data.error);
        } else {
          showSuccess(data.message || 'Conexión UBIKA OK');
        }
      } catch (err) {
        setFleetGpsTestResult(null);
        showError(err.message || 'Error al probar GPS UBIKA');
      }
    });
  };

  if (!hasPermission(currentUser, 'access.control')) return null;

  return (
    <div className="admin-sub-section">
      <h3 className="text-xl font-medium text-gray-800 mb-3">GPS flota interna (UBIKA)</h3>
      <p className="text-sm text-gray-600 mb-4">
        Detecta tránsito en el portón (entrando/saliendo), no los móviles estacionados en planta.
        Puede usar círculos rápidos o dibujar polígonos sobre cada portón en el mapa (recomendado si hay 2 accesos).
      </p>

      {loading && (
        <div className="admin-section-loading">
          <Loader2 className="animate-spin" size={32} />
          <span>Cargando sección…</span>
        </div>
      )}

      <form onSubmit={handleSaveFleetGps} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
          <input
            type="checkbox"
            checked={Boolean(fleetGpsConfig.enabled)}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
          />
          Habilitar monitoreo GPS en panel del guardia
        </label>
        <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
          <input
            type="checkbox"
            checked={fleetGpsConfig.autoRegisterMovements !== false}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, autoRegisterMovements: e.target.checked }))}
          />
          Registrar automáticamente ingresos/egresos en el libro de guardia
        </label>
        <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
          <input
            type="checkbox"
            checked={fleetGpsConfig.requireMotion !== false}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, requireMotion: e.target.checked }))}
          />
          Solo contar móviles en movimiento (ignora estacionados)
        </label>
        <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
          <input
            type="checkbox"
            checked={fleetGpsConfig.approachAlertEnabled === true}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, approachAlertEnabled: e.target.checked }))}
          />
          Alerta de vehículo acercándose a planta (avisa al guardia en el panel GPS). Compatible con polígonos de Portón Santiago y Portón Olmos.
        </label>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Latitud guardia</label>
          <input
            type="number"
            step="any"
            value={fleetGpsConfig.guardiaLat}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLat: e.target.value }))}
            className="input-field"
            placeholder="-31.420000"
            required={fleetGpsConfig.enabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Longitud guardia</label>
          <input
            type="number"
            step="any"
            value={fleetGpsConfig.guardiaLng}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, guardiaLng: e.target.value }))}
            className="input-field"
            placeholder="-64.180000"
            required={fleetGpsConfig.enabled}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Radio portón (metros)</label>
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
          <p className="text-xs text-gray-500 mt-1">
            {fleetGpsConfig.geofenceMode === 'polygon'
              ? 'En modo polígonos se usa el dibujo del mapa.'
              : 'Zona de tránsito. Recomendado 35–50 m.'}
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Radio planta (metros)</label>
          <input
            type="number"
            min="80"
            max="2000"
            value={fleetGpsConfig.plantRadiusMeters ?? 400}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, plantRadiusMeters: Number(e.target.value) }))}
            className="input-field"
          />
          <p className="text-xs text-gray-500 mt-1">Respaldo si no dibuja polígono de planta.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Radio alerta llegada (metros)</label>
          <input
            type="number"
            min="100"
            max="3000"
            value={fleetGpsConfig.approachRadiusMeters ?? 400}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, approachRadiusMeters: Number(e.target.value) }))}
            className="input-field"
            disabled={!fleetGpsConfig.approachAlertEnabled}
          />
          <p className="text-xs text-gray-500 mt-1">
            Avisa cuando un móvil en movimiento entra en este radio y aún no está en planta/portón.
            El ingreso/egreso se registra al cruzar el polígono del portón (Santiago u Olmos).
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Velocidad mínima (nudos)</label>
          <input
            type="number"
            min="0"
            max="20"
            step="0.5"
            value={fleetGpsConfig.minSpeedKnots ?? 1}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, minSpeedKnots: Number(e.target.value) }))}
            className="input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Espera entre registros (seg)</label>
          <input
            type="number"
            min="60"
            max="3600"
            value={fleetGpsConfig.movementCooldownSeconds ?? 300}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, movementCooldownSeconds: Number(e.target.value) }))}
            className="input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Consulta cada (segundos)</label>
          <input
            type="number"
            min="15"
            max="120"
            value={fleetGpsConfig.pollIntervalSeconds}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, pollIntervalSeconds: Number(e.target.value) }))}
            className="input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">URL API UBIKA</label>
          <input
            type="text"
            value={fleetGpsConfig.apiUrl}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiUrl: e.target.value }))}
            className="input-field"
            placeholder="https://ubika.rastreo.com.ar"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Token API</label>
          <input
            type="password"
            value={fleetGpsConfig.apiKey}
            onChange={(e) => setFleetGpsConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
            className="input-field"
            placeholder={fleetGpsConfig.hasApiKey ? 'Token configurado' : 'Bearer token'}
            autoComplete="off"
          />
        </div>
        <div className="md:col-span-2 xl:col-span-3 flex flex-wrap gap-3">
          <PendingButton type="submit" actionId="saveFleetGps" pendingAction={pendingAction} className="btn btn-primary" pendingLabel="Guardando...">
            <Save size={18} /> Guardar GPS UBIKA
          </PendingButton>
          <PendingButton type="button" actionId="testFleetGps" pendingAction={pendingAction} className="btn btn-secondary" pendingLabel="Probando..." onClick={handleTestFleetGps}>
            <ShieldCheck size={18} /> Probar conexión
          </PendingButton>
        </div>
        {(fleetGpsConfig.lastError || fleetGpsConfig.lastSyncAt) && !fleetGpsTestResult && (
          <div className="md:col-span-2 xl:col-span-3 text-sm text-gray-600">
            {fleetGpsConfig.lastSyncAt && (
              <p>Última sincronización: {formatFleetTime(fleetGpsConfig.lastSyncAt)}</p>
            )}
            {fleetGpsConfig.lastError && (
              <p className="text-red-600">Último error: {fleetGpsConfig.lastError}</p>
            )}
          </div>
        )}
        {fleetGpsTestResult && (
          <div className="md:col-span-2 xl:col-span-3 fleet-gps-admin-result">
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
                <span className="fleet-gps-summary__label">Estado</span>
                <span className="fleet-gps-summary__text">
                  {fleetGpsTestResult.error || fleetGpsTestResult.message}
                </span>
                <span className="fleet-gps-summary__meta">
                  Portón {fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters || 45} m
                  {' · '}
                  Planta {fleetGpsTestResult.plantRadiusMeters || fleetGpsConfig.plantRadiusMeters || 400} m
                  {fleetGpsTestResult.config?.lastSyncAt
                    ? ` · ${formatFleetTime(fleetGpsTestResult.config.lastSyncAt)}`
                    : ''}
                </span>
              </div>
            </div>

            {(fleetGpsTestResult.transit || fleetGpsTestResult.alerts || []).length > 0 ? (
              <>
                <h4 className="fleet-gps-section-title">Tránsito en portón (entrando / saliendo)</h4>
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
                <h4 className="fleet-gps-section-title">Más cercanos al portón (sin tránsito ahora)</h4>
                <FleetGpsVehicleTable
                  vehicles={fleetGpsTestResult.nearest || []}
                  radiusMeters={Number(fleetGpsTestResult.gateRadiusMeters || fleetGpsConfig.gateRadiusMeters) || 45}
                  emptyMessage="No se obtuvieron posiciones de la flota"
                />
              </>
            )}
          </div>
        )}
      </form>

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
    </div>
  );
}

export default AccessGpsAdminSection;
