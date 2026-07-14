import React, { useMemo } from 'react';
import {
  User,
  Car,
  Truck,
  ClipboardList,
  ArrowDownCircle,
  ArrowUpCircle,
  Activity,
} from 'lucide-react';
import { useLiveClock } from '../hooks/useLiveClock';
import { getDashboardStats, formatEntryRow } from '../utils/dashboardStats';
import FleetGatePanel from './FleetGatePanel';
import AttendanceMissingPanel from './AttendanceMissingPanel';
import CitadosPanel from './CitadosPanel';

const QUICK_ACTIONS = [
  { id: 'personal', label: 'Registrar personal', icon: User },
  { id: 'vehiculo', label: 'Registrar vehículo', icon: Car },
  { id: 'flota', label: 'Registrar flota', icon: Truck },
  { id: 'novedad', label: 'Cargar novedad', icon: ClipboardList },
];

function HomeDashboard({
  entries,
  currentUser,
  onNavigate,
  authToken,
  showFleetGps = false,
  showAttendanceAlerts = false,
  showCitados = false,
  onGpsMovementRegistered,
  onAttendanceRegistered,
}) {
  const { timeDisplay, timeInputValue, dateDisplay } = useLiveClock();
  const stats = useMemo(() => getDashboardStats(entries), [entries]);
  const recentRows = useMemo(
    () => stats.recentEntries.map(formatEntryRow),
    [stats.recentEntries],
  );

  return (
    <div className="home-dashboard">
      {showFleetGps && (
        <FleetGatePanel
          authToken={authToken}
          enabled
          pollSeconds={20}
          onMovementRegistered={onGpsMovementRegistered}
        />
      )}

      {showCitados && (
        <CitadosPanel
          authToken={authToken}
          enabled
          pollSeconds={60}
          onRegistered={onAttendanceRegistered}
        />
      )}

      {showAttendanceAlerts && (
        <AttendanceMissingPanel
          authToken={authToken}
          enabled
          pollSeconds={60}
          onRegistered={onAttendanceRegistered}
        />
      )}

      <section className="home-hero">
        <div>
          <p className="home-hero-kicker">Turno de guardia</p>
          <h2 className="home-hero-title">Hola, {currentUser.username}</h2>
          <p className="home-hero-subtitle capitalize">{currentUser.role} · {dateDisplay}</p>
        </div>
        <div className="home-hero-clock">
          <div className="home-hero-clock-time" aria-live="polite">{timeDisplay}</div>
          <button
            type="button"
            className="live-clock-btn live-clock-btn-primary"
            onClick={() => onNavigate('personal', timeInputValue)}
          >
            Registrar personal con hora {timeInputValue}
          </button>
        </div>
      </section>

      <section className="kpi-grid">
        <article className="kpi-card kpi-card-accent">
          <Activity size={20} />
          <div>
            <p className="kpi-value">{stats.totalToday}</p>
            <p className="kpi-label">Movimientos hoy</p>
          </div>
        </article>
        <article className="kpi-card">
          <ArrowDownCircle size={20} className="kpi-icon-success" />
          <div>
            <p className="kpi-value">{stats.personalIngresos}</p>
            <p className="kpi-label">Ingresos personal</p>
          </div>
        </article>
        <article className="kpi-card">
          <ArrowUpCircle size={20} className="kpi-icon-warn" />
          <div>
            <p className="kpi-value">{stats.personalEgresos}</p>
            <p className="kpi-label">Egresos personal</p>
          </div>
        </article>
        <article className="kpi-card">
          <Car size={20} />
          <div>
            <p className="kpi-value">{stats.vehiculos}</p>
            <p className="kpi-label">Vehículos</p>
          </div>
        </article>
        <article className="kpi-card">
          <Truck size={20} />
          <div>
            <p className="kpi-value">{stats.flota}</p>
            <p className="kpi-label">Flota interna</p>
          </div>
        </article>
        <article className="kpi-card">
          <ClipboardList size={20} />
          <div>
            <p className="kpi-value">{stats.novedades}</p>
            <p className="kpi-label">Novedades</p>
          </div>
        </article>
      </section>

      <section className="home-quick-actions">
        <h3>Accesos rápidos</h3>
        <div className="home-quick-grid">
          {QUICK_ACTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="home-quick-card"
              onClick={() => onNavigate(id, timeInputValue)}
            >
              <Icon size={22} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-recent">
        <div className="home-recent-header">
          <h3>Últimos movimientos</h3>
          <button type="button" className="home-link-btn" onClick={() => onNavigate('historial')}>
            Ver historial
          </button>
        </div>
        {recentRows.length === 0 ? (
          <p className="home-empty">Sin registros todavía. Comience desde Personal o Vehículos.</p>
        ) : (
          <div className="home-recent-list">
            {recentRows.map((row) => (
              <div key={row.id} className="home-recent-item">
                <div>
                  <p className="home-recent-type">{row.typeDisplay}</p>
                  <p className="home-recent-detail">{row.mainDetail}</p>
                </div>
                <div className="home-recent-meta">
                  <span>{row.eventTime}</span>
                  <span>{row.registeredBy}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default HomeDashboard;
