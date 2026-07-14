import React, { useMemo } from 'react';
import {
  ArrowRight
} from 'lucide-react';
import { useLiveClock } from '../../hooks/useLiveClock';
import { getDashboardStats, formatEntryRow } from '../../utils/dashboardStats';
import { getProfileKicker } from '../../utils/navigation';

function DashboardShell({
  currentUser,
  entries,
  onNavigate,
  kicker,
  title,
  subtitle,
  kpis = [],
  quickActions = [],
  panels = null,
  recentEntries = null
}) {
  const { timeDisplay, dateDisplay } = useLiveClock();
  const stats = useMemo(() => getDashboardStats(entries), [entries]);
  const recentRows = useMemo(
    () => (recentEntries || stats.recentEntries).map(formatEntryRow),
    [recentEntries, stats.recentEntries]
  );

  return (
    <div className="home-dashboard">
      {panels}
      <section className="home-hero">
        <div>
          <p className="home-hero-kicker">{kicker || getProfileKicker(currentUser)}</p>
          <h2 className="home-hero-title">{title || `Hola, ${currentUser.username}`}</h2>
          <p className="home-hero-subtitle">
            {subtitle || `${currentUser.roleLabel || currentUser.role} · ${dateDisplay}`}
          </p>
        </div>
        <div className="home-hero-clock">
          <div className="home-hero-clock-time" aria-live="polite">{timeDisplay}</div>
        </div>
      </section>

      {kpis.length > 0 && (
        <section className="kpi-grid">
          {kpis.map(({ label, value, icon: Icon, accent }) => (
            <article key={label} className={`kpi-card${accent ? ' kpi-card-accent' : ''}`}>
              <Icon size={20} />
              <div>
                <p className="kpi-value">{value}</p>
                <p className="kpi-label">{label}</p>
              </div>
            </article>
          ))}
        </section>
      )}

      {quickActions.length > 0 && (
        <section className="home-quick-actions">
          <h3>Accesos rápidos</h3>
          <div className="home-quick-grid">
            {quickActions.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="home-quick-card"
                onClick={() => onNavigate(id)}
              >
                <Icon size={22} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="home-recent">
        <div className="home-recent-header">
          <h3>Últimos movimientos</h3>
          <button type="button" className="home-link-btn" onClick={() => onNavigate('historial')}>
            Ver historial <ArrowRight size={14} />
          </button>
        </div>
        {recentRows.length === 0 ? (
          <p className="home-empty">Sin registros recientes en su puesto.</p>
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

export default DashboardShell;
