import React, { useCallback, useEffect, useState } from 'react';
import {
  Truck,
  ClipboardList,
  X,
  Users,
  UserCheck,
  Car,
  CalendarCheck,
  DoorOpen
} from 'lucide-react';
import { hasPermission } from '../utils/permissions';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../services/api';
import DigitalDoorPanel from './DigitalDoorPanel';
import NovedadPage from '../pages/Novedad/NovedadPage';

function StatTile({ icon: Icon, label, value, hint, tone = 'neutral' }) {
  return (
    <article className={`guard-ops-tile guard-ops-tile--${tone}`}>
      <div className="guard-ops-tile__icon" aria-hidden>
        <Icon size={22} />
      </div>
      <div className="guard-ops-tile__body">
        <span className="guard-ops-tile__value">{value ?? '—'}</span>
        <span className="guard-ops-tile__label">{label}</span>
        {hint ? <span className="guard-ops-tile__hint">{hint}</span> : null}
      </div>
    </article>
  );
}

/**
 * Puesto operativo de guardia: KPIs en vivo + botonera de puertas + novedad.
 */
function GuardiaControlCenter({
  showFleet = true,
  showDoors = true,
  showNovedad = true,
  onNavigate
}) {
  const { authToken, currentUser } = useAuth();
  const [novedadOpen, setNovedadOpen] = useState(false);
  const [fleet, setFleet] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [citados, setCitados] = useState(null);
  const [authorizations, setAuthorizations] = useState(null);
  const [loadError, setLoadError] = useState('');

  const canFleet = showFleet && (
    hasPermission(currentUser, 'entries.view')
    || hasPermission(currentUser, 'entries.create')
    || hasPermission(currentUser, 'fleet.gps.read')
  );
  const canDoors = showDoors && (
    hasPermission(currentUser, 'access.manual_open')
    || hasPermission(currentUser, 'guard.doors.panel')
  );
  const canNovedad = showNovedad && hasPermission(currentUser, 'entries.create');
  const canAttendance = hasPermission(currentUser, 'attendance.alerts.read');
  const canAuthToday = hasPermission(currentUser, 'master.citaciones.read');

  const reloadKpis = useCallback(async () => {
    if (!authToken) return;
    const today = new Date().toISOString().slice(0, 10);
    const tasks = [];

    if (canFleet) {
      tasks.push(
        apiFetch('/guard/fleet-presence', { token: authToken, allowForbidden: true })
          .then((d) => setFleet(d))
          .catch((err) => {
            setFleet(null);
            setLoadError(err.message || 'No se pudo cargar presencia de flota');
          })
      );
    }
    if (canAttendance) {
      tasks.push(
        apiFetch('/guard/attendance/missing', { token: authToken, allowForbidden: true })
          .then((d) => setAttendance(d))
          .catch(() => setAttendance(null))
      );
      tasks.push(
        apiFetch('/guard/citados/today', { token: authToken, allowForbidden: true })
          .then((d) => setCitados(d))
          .catch(() => setCitados(null))
      );
    }
    if (canAuthToday) {
      tasks.push(
        apiFetch(`/guard/authorizations?scope=external&date=${today}`, {
          token: authToken,
          allowForbidden: true
        })
          .then((d) => setAuthorizations(d))
          .catch(() => setAuthorizations(null))
      );
    }

    try {
      await Promise.all(tasks);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message || 'No se pudieron actualizar los indicadores');
    }
  }, [authToken, canFleet, canAttendance, canAuthToday]);

  useEffect(() => {
    reloadKpis();
    const id = setInterval(reloadKpis, 15000);
    return () => clearInterval(id);
  }, [reloadKpis]);

  if (!canFleet && !canDoors && !canNovedad && !canAttendance) return null;

  const authCount = Array.isArray(authorizations?.authorizations)
    ? authorizations.authorizations.length
    : (Number(authorizations?.count) || null);

  return (
    <div className="guard-ops">
      <header className="guard-ops__hero">
        <div>
          <p className="guard-ops__eyebrow">Puesto de guardia</p>
          <h2>Centro operativo</h2>
          <p>Estado de planta, puertas y novedades — pensado para uso rápido en puesto.</p>
        </div>
        <div className="guard-ops__hero-actions">
          {canNovedad && (
            <button type="button" className="btn btn-primary guard-ops__novedad-btn" onClick={() => setNovedadOpen(true)}>
              <ClipboardList size={18} />
              Cargar novedad
            </button>
          )}
          {typeof onNavigate === 'function' && canDoors && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onNavigate('botonera')}
            >
              <DoorOpen size={18} />
              Solo puertas
            </button>
          )}
        </div>
      </header>

      {loadError ? <p className="guard-ops__error">{loadError}</p> : null}

      <section className="guard-ops__kpis" aria-label="Indicadores de planta">
        {canFleet && (
          <>
            <StatTile
              icon={Truck}
              label="Móviles en planta"
              value={fleet?.inside}
              tone="in"
              hint="Según último ingreso/egreso"
            />
            <StatTile
              icon={Truck}
              label="Móviles afuera"
              value={fleet?.outside}
              tone="out"
            />
          </>
        )}
        {canAttendance && (
          <>
            <StatTile
              icon={UserCheck}
              label="Personal en planta"
              value={attendance?.presentCount}
              tone="in"
              hint={attendance?.expectedCount != null
                ? `Esperados hoy: ${attendance.expectedCount}`
                : null}
            />
            <StatTile
              icon={Users}
              label="Ausentes / faltantes"
              value={attendance?.absentCount}
              tone="warn"
            />
            <StatTile
              icon={CalendarCheck}
              label="Citados hoy"
              value={citados?.expectedCount ?? citados?.presentCount}
              hint={citados?.absentCount != null
                ? `Sin marcar: ${citados.absentCount}`
                : null}
            />
          </>
        )}
        {canAuthToday && (
          <StatTile
            icon={Car}
            label="Autorizados / visitas del día"
            value={authCount}
            hint="Personas/vehículos autorizados para hoy"
          />
        )}
      </section>

      {canDoors && (
        <section className="guard-ops__doors">
          <DigitalDoorPanel
            profile="guardia"
            canManualOpen
            pollSeconds={20}
            botoneraMode
          />
        </section>
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
