import React, { useCallback, useEffect, useState } from 'react';
import { Truck, ClipboardList, X } from 'lucide-react';
import { hasPermission } from '../utils/permissions';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../services/api';
import DigitalDoorPanel from './DigitalDoorPanel';
import NovedadPage from '../pages/Novedad/NovedadPage';

function FleetPresenceBlock({ authToken, enabled, pollSeconds = 12 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!authToken || !enabled) return;
    try {
      const presence = await apiFetch('/guard/fleet-presence', {
        token: authToken,
        allowForbidden: true
      });
      setData(presence);
      setError('');
    } catch (err) {
      setError(err.message || 'No se pudo cargar presencia de flota');
    }
  }, [authToken, enabled]);

  useEffect(() => {
    reload();
    // Sin onSnapshot en el proyecto: mismo patrón de poll que FleetGatePanel / EntriesContext.
    const id = setInterval(reload, Math.max(5, pollSeconds) * 1000);
    return () => clearInterval(id);
  }, [reload, pollSeconds]);

  if (!enabled) return null;

  return (
    <section className="control-fleet" aria-live="polite">
      <div className="control-fleet__header">
        <Truck size={22} />
        <div>
          <h3>Flota en planta</h3>
          <p>Según el último ingreso/egreso registrado de cada móvil</p>
        </div>
      </div>
      {error && <p className="control-fleet__error">{error}</p>}
      <div className="control-fleet__counts">
        <div className="control-fleet__stat control-fleet__stat--in">
          <span className="control-fleet__num">{data?.inside ?? '—'}</span>
          <span className="control-fleet__label">Adentro</span>
        </div>
        <div className="control-fleet__stat control-fleet__stat--out">
          <span className="control-fleet__num">{data?.outside ?? '—'}</span>
          <span className="control-fleet__label">Afuera</span>
        </div>
      </div>
      {data?.queriedAt && (
        <p className="control-fleet__meta">
          Actualizado {new Date(data.queriedAt).toLocaleTimeString('es-AR')}
        </p>
      )}
    </section>
  );
}

/**
 * Centro de control operativo: flota + puertas + novedad rápida.
 */
function GuardiaControlCenter({ showFleet = true, showDoors = true, showNovedad = true }) {
  const { authToken, currentUser } = useAuth();
  const [novedadOpen, setNovedadOpen] = useState(false);

  const canFleet = showFleet && (
    hasPermission(currentUser, 'entries.view')
    || hasPermission(currentUser, 'entries.create')
    || hasPermission(currentUser, 'fleet.gps.read')
  );
  const canDoors = showDoors && hasPermission(currentUser, 'access.manual_open');
  const canNovedad = showNovedad && hasPermission(currentUser, 'entries.create');

  if (!canFleet && !canDoors && !canNovedad) return null;

  return (
    <div className="guardia-control-center">
      <div className="guardia-control-center__title">
        <h2>Centro de control</h2>
        <p>Estado en vivo y acciones del puesto</p>
      </div>

      <div className="guardia-control-center__row">
        {canFleet && (
          <FleetPresenceBlock authToken={authToken} enabled pollSeconds={12} />
        )}
        {canNovedad && (
          <section className="control-novedad-quick">
            <ClipboardList size={22} />
            <div>
              <h3>Novedad urgente</h3>
              <p>Registrar sin salir del centro de control</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => setNovedadOpen(true)}>
              Cargar novedad
            </button>
          </section>
        )}
      </div>

      {canDoors && (
        <DigitalDoorPanel profile="guardia" canManualOpen pollSeconds={20} />
      )}

      {novedadOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="novedad-modal-title">
          <div className="modal-content control-novedad-modal">
            <div className="control-novedad-modal__bar">
              <h2 id="novedad-modal-title">Novedad rápida</h2>
              <button
                type="button"
                className="theme-toggle-btn"
                onClick={() => setNovedadOpen(false)}
                aria-label="Cerrar"
              >
                <X size={18} />
              </button>
            </div>
            <NovedadPage />
          </div>
        </div>
      )}
    </div>
  );
}

export default GuardiaControlCenter;
