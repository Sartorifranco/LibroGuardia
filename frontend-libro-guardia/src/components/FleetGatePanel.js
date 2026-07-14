import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Truck,
  ArrowDownCircle,
  ArrowUpCircle,
  RefreshCw,
  MapPin,
  ParkingCircle,
  Radio
} from 'lucide-react';
import FleetGpsVehicleTable, { formatDistance, formatFleetTime } from './FleetGpsVehicleTable';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

function FleetGatePanel({
  authToken,
  enabled = true,
  pollSeconds = 20,
  compact = false,
  onMovementRegistered
}) {
  const [transit, setTransit] = useState([]);
  const [approaching, setApproaching] = useState([]);
  const [atGateStopped, setAtGateStopped] = useState([]);
  const [inPlantCount, setInPlantCount] = useState(0);
  const [vehicleCount, setVehicleCount] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pollMs, setPollMs] = useState(Math.max(pollSeconds, 15) * 1000);
  const seenEntryIdsRef = useRef(new Set());
  const onMovementRegisteredRef = useRef(onMovementRegistered);
  onMovementRegisteredRef.current = onMovementRegistered;

  const fetchStatus = useCallback(async (manual = false) => {
    if (!authToken || !enabled) return;
    if (manual) setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/guard/fleet-gps/alerts`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error GPS');

      const nextTransit = data.transit || data.alerts || [];
      setTransit(nextTransit);
      setApproaching(data.approaching || []);
      setAtGateStopped(data.atGateStopped || []);
      setInPlantCount((data.inPlant || []).length);
      setVehicleCount(data.vehicleCount || 0);
      setMessage(data.message || '');
      setError(data.error || '');
      setConfig(data.config || null);

      const configuredPoll = Number(data.config?.pollIntervalSeconds);
      if (!Number.isNaN(configuredPoll) && configuredPoll >= 15) {
        setPollMs(configuredPoll * 1000);
      }

      const newlyRegistered = (data.registered || []).filter((item) => {
        if (!item.entryId || seenEntryIdsRef.current.has(item.entryId)) return false;
        seenEntryIdsRef.current.add(item.entryId);
        return true;
      });
      if (newlyRegistered.length) {
        onMovementRegisteredRef.current?.(newlyRegistered);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      if (manual) setLoading(false);
    }
  }, [authToken, enabled]);

  useEffect(() => {
    fetchStatus(false);
    if (!enabled) return undefined;
    const timer = setInterval(() => fetchStatus(false), pollMs);
    return () => clearInterval(timer);
  }, [fetchStatus, enabled, pollMs]);

  if (!enabled) return null;

  const gateRadius = config?.gateRadiusMeters || 45;
  const plantRadius = config?.plantRadiusMeters || 400;
  const entrando = transit.filter((item) => item.direction === 'ingreso');
  const saliendo = transit.filter((item) => item.direction === 'egreso');
  const hasTransit = transit.length > 0;
  const hasApproaching = approaching.length > 0;
  const approachRadius = config?.approachRadiusMeters || 400;

  if (compact) {
    if (!hasTransit && !hasApproaching && !error) return null;
    return (
      <div className={`fleet-gps-alert${hasTransit || hasApproaching ? ' fleet-gps-alert--active' : ''}`}>
        <div className="fleet-gps-alert__header">
          <Truck size={22} />
          <div className="fleet-gps-alert__title-wrap">
            <p className="fleet-gps-alert__title">
              {hasTransit
                ? `Portón: ${entrando.length} entrando · ${saliendo.length} saliendo`
                : hasApproaching
                  ? `GPS: ${approaching.length} llegando a planta`
                  : 'GPS de flota'}
            </p>
            {config?.lastSyncAt && (
              <p className="fleet-gps-alert__meta">{formatFleetTime(config.lastSyncAt)}</p>
            )}
          </div>
        </div>
        {error && <p className="fleet-gps-alert__error">{error}</p>}
        {hasApproaching && !hasTransit && (
          <div className="fleet-gps-alert__table">
            <FleetGpsVehicleTable
              vehicles={approaching.map((item) => ({
                ...item,
                name: item.approachLabel || `Llegando: ${item.name}`,
                distanceMeters: item.centerDistanceMeters ?? item.distanceMeters
              }))}
              radiusMeters={approachRadius}
              compact
              maxHeightClass="fleet-gps-alert-scroll"
            />
          </div>
        )}
        {hasTransit && (
          <div className="fleet-gps-alert__table">
            <FleetGpsVehicleTable
              vehicles={transit.map((item) => ({
                ...item,
                name: `${item.directionLabel}: ${item.name}`
              }))}
              radiusMeters={gateRadius}
              compact
              maxHeightClass="fleet-gps-alert-scroll"
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <section className={`fleet-gate-panel${hasTransit || hasApproaching ? ' fleet-gate-panel--active' : ''}`}>
      <div className="fleet-gate-panel__header">
        <div>
          <p className="fleet-gate-panel__kicker">Flota interna · UBIKA</p>
          <h3 className="fleet-gate-panel__title">Tránsito en portón</h3>
          <p className="fleet-gate-panel__subtitle">
            Detecta móviles en movimiento dentro de {gateRadius} m del portón.
            Los estacionados en planta (hasta {plantRadius} m) no generan alerta.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary fleet-gate-refresh"
          onClick={() => fetchStatus(true)}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          Actualizar
        </button>
      </div>

      <div className="fleet-gate-summary">
        <article className={`fleet-gate-kpi${entrando.length ? ' fleet-gate-kpi--in' : ''}`}>
          <ArrowDownCircle size={20} />
          <div>
            <p className="fleet-gate-kpi__value">{entrando.length}</p>
            <p className="fleet-gate-kpi__label">Entrando</p>
          </div>
        </article>
        <article className={`fleet-gate-kpi${saliendo.length ? ' fleet-gate-kpi--out' : ''}`}>
          <ArrowUpCircle size={20} />
          <div>
            <p className="fleet-gate-kpi__value">{saliendo.length}</p>
            <p className="fleet-gate-kpi__label">Saliendo</p>
          </div>
        </article>
        <article className="fleet-gate-kpi">
          <ParkingCircle size={20} />
          <div>
            <p className="fleet-gate-kpi__value">{inPlantCount}</p>
            <p className="fleet-gate-kpi__label">En planta (quietos)</p>
          </div>
        </article>
        <article className={`fleet-gate-kpi${hasApproaching ? ' fleet-gate-kpi--approach' : ''}`}>
          <Radio size={20} />
          <div>
            <p className="fleet-gate-kpi__value">{approaching.length}</p>
            <p className="fleet-gate-kpi__label">Llegando ({approachRadius} m)</p>
          </div>
        </article>
        <article className="fleet-gate-kpi">
          <MapPin size={20} />
          <div>
            <p className="fleet-gate-kpi__value">{vehicleCount}</p>
            <p className="fleet-gate-kpi__label">Flota total</p>
          </div>
        </article>
      </div>

      {error && <p className="fleet-gate-error">{error}</p>}
      {!error && (
        <p className="fleet-gate-status">
          {message}
          {config?.lastSyncAt ? ` · ${formatFleetTime(config.lastSyncAt)}` : ''}
          {config?.autoRegisterMovements !== false ? ' · Registro automático activo' : ' · Solo alerta'}
        </p>
      )}

      {hasApproaching && (
        <div className="fleet-gate-approaching">
          <h4 className="fleet-gps-section-title">Acercándose a planta</h4>
          <p className="fleet-gate-approaching__hint">
            Móviles en movimiento dentro de {approachRadius} m que aún no ingresaron a planta ni portón.
            Visible para guardia y supervisión con permiso GPS.
          </p>
          <div className="fleet-gate-transit-list">
            {approaching.map((item) => (
              <article
                key={`approach-${item.deviceId}-${item.centerDistanceMeters}`}
                className="fleet-gate-card fleet-gate-card--approach"
              >
                <div className="fleet-gate-card__badge fleet-gate-card__badge--approach">
                  <Radio size={18} />
                  Llegando
                </div>
                <div className="fleet-gate-card__body">
                  <p className="fleet-gate-card__name">{item.name}</p>
                  <p className="fleet-gate-card__meta">
                    <span className="fleet-gps-plate">{item.plate || 'Sin patente'}</span>
                    <span>{formatDistance(item.centerDistanceMeters ?? item.distanceMeters)}</span>
                    <span>En movimiento</span>
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {hasTransit ? (
        <div className="fleet-gate-transit-list">
          {transit.map((item) => (
            <article
              key={`${item.deviceId}-${item.direction}-${item.distanceMeters}`}
              className={`fleet-gate-card fleet-gate-card--${item.direction}`}
            >
              <div className="fleet-gate-card__badge">
                {item.direction === 'ingreso' ? <ArrowDownCircle size={18} /> : <ArrowUpCircle size={18} />}
                {item.directionLabel}
              </div>
              <div className="fleet-gate-card__body">
                <p className="fleet-gate-card__name">{item.name}</p>
                <p className="fleet-gate-card__meta">
                  <span className="fleet-gps-plate">{item.plate || 'Sin patente'}</span>
                  <span>{formatDistance(item.distanceMeters)}</span>
                  <span>{item.moving ? 'En movimiento' : 'Detenido'}</span>
                  {item.registered && <span className="fleet-gate-card__ok">Registrado en libro</span>}
                  {item.cooldown && <span>Ya registrado (espera)</span>}
                </p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="fleet-gate-empty">
          No hay móviles cruzando el portón ahora.
          {atGateStopped.length > 0
            ? ` ${atGateStopped.length} detenido(s) en zona de portón (sin movimiento).`
            : ''}
        </p>
      )}
    </section>
  );
}

export default FleetGatePanel;
