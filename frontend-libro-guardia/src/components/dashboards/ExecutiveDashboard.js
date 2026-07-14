import React, { useMemo } from 'react';
import {
  User,
  Car,
  Truck,
  ClipboardList,
  Activity,
  Shield,
  Radio,
  CalendarCheck,
  List,
  FileText,
  ArrowDownCircle,
  ArrowUpCircle,
  Settings
} from 'lucide-react';
import { useLiveClock } from '../../hooks/useLiveClock';
import { getExecutiveChartData, buildDonutGradient } from '../../utils/dashboardCharts';
import { hasPermission, canAccessAdmin } from '../../utils/permissions';
import { getProfileKicker } from '../../utils/navigation';

function ExecutiveDashboard({ currentUser, entries, onNavigate, isAdmin = false }) {
  const { timeDisplay, dateDisplay } = useLiveClock();
  const chart = useMemo(() => getExecutiveChartData(entries), [entries]);
  const donutStyle = useMemo(
    () => ({ background: buildDonutGradient(chart.byType) }),
    [chart.byType]
  );

  const quickLinks = [
    {
      id: 'personal',
      label: 'Personal',
      hint: `${chart.stats.personalIngresos} ing. · ${chart.stats.personalEgresos} egr.`,
      icon: User,
      show: hasPermission(currentUser, 'entries.create')
    },
    {
      id: 'vehiculosAutorizados',
      label: 'Vehículos Monitoreo',
      hint: `${chart.stats.vehiculos} hoy`,
      icon: Car,
      show: hasPermission(currentUser, 'monitoring.vehicles.manage')
        || hasPermission(currentUser, 'master.vehicles.quick_authorize')
    },
    {
      id: 'flota',
      label: 'Flota / tránsito',
      hint: `${chart.stats.flota} hoy · GPS`,
      icon: Truck,
      show: hasPermission(currentUser, 'fleet.gps.read') || hasPermission(currentUser, 'entries.create')
    },
    {
      id: 'citados',
      label: 'Citados y faltantes',
      hint: 'Asistencia del día',
      icon: CalendarCheck,
      show: hasPermission(currentUser, 'attendance.alerts.read')
    },
    {
      id: 'autorizados',
      label: 'Autorizados',
      hint: 'Visitas y citaciones',
      icon: Shield,
      show: hasPermission(currentUser, 'master.citaciones.read')
    },
    {
      id: 'novedad',
      label: 'Novedades',
      hint: `${chart.stats.novedades} hoy`,
      icon: ClipboardList,
      show: hasPermission(currentUser, 'entries.create')
    },
    {
      id: 'allRecords',
      label: 'Todos los registros',
      hint: 'Detalle completo',
      icon: List,
      show: hasPermission(currentUser, 'entries.view')
    },
    {
      id: 'reportes',
      label: 'Reportes',
      hint: 'Exportar datos',
      icon: FileText,
      show: hasPermission(currentUser, 'reports.export')
    },
    {
      id: 'adminPanel',
      label: isAdmin ? 'Configuración' : 'Panel operativo',
      hint: isAdmin ? 'Sistema completo' : 'Gestión diaria',
      icon: isAdmin ? Settings : Radio,
      show: canAccessAdmin(currentUser),
      isAdmin: true
    }
  ].filter((item) => item.show);

  const handleNavigate = (id) => {
    if (id === 'adminPanel') onNavigate('adminPanel');
    else onNavigate(id);
  };

  return (
    <div className="exec-dashboard">
      <header className="exec-dashboard__hero">
        <div>
          <p className="exec-dashboard__kicker">{getProfileKicker(currentUser)}</p>
          <h2 className="exec-dashboard__title">
            {isAdmin ? 'Vista general' : 'Supervisión operativa'}
          </h2>
          <p className="exec-dashboard__date">{dateDisplay}</p>
        </div>
        <div className="exec-dashboard__hero-stat">
          <span className="exec-dashboard__hero-value">{chart.stats.totalToday}</span>
          <span className="exec-dashboard__hero-label">movimientos hoy</span>
          <span className="exec-dashboard__clock">{timeDisplay}</span>
        </div>
      </header>

      <section className="exec-charts">
        <article className="exec-chart-card exec-chart-card--donut">
          <h3>Distribución del día</h3>
          <div className="exec-donut-wrap">
            <div className="exec-donut" style={donutStyle}>
              <div className="exec-donut__hole">
                <strong>{chart.totalByType}</strong>
                <span>total</span>
              </div>
            </div>
            <ul className="exec-legend">
              {chart.byType.map((item) => (
                <li key={item.key}>
                  <span className="exec-legend__dot" style={{ background: item.color }} />
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="exec-chart-card">
          <h3>Actividad por hora</h3>
          <p className="exec-chart-sub">
            Pico: {chart.peakHour.count} mov. a las {String(chart.peakHour.hour).padStart(2, '0')}:00
          </p>
          <div className="exec-hour-chart" role="img" aria-label="Gráfico de actividad por hora">
            {chart.byHour.map((item) => (
              <div key={item.hour} className="exec-hour-bar" title={`${item.hour}:00 — ${item.count}`}>
                <div
                  className="exec-hour-bar__fill"
                  style={{ height: `${(item.count / chart.maxHourCount) * 100}%` }}
                />
                {item.hour % 3 === 0 && (
                  <span className="exec-hour-bar__label">{item.hour}</span>
                )}
              </div>
            ))}
          </div>
        </article>

        <article className="exec-chart-card exec-chart-card--flow">
          <h3>Personal hoy</h3>
          <div className="exec-flow-bars">
            <div className="exec-flow-row">
              <span><ArrowDownCircle size={16} /> Ingresos</span>
              <div className="exec-flow-track">
                <div
                  className="exec-flow-fill exec-flow-fill--in"
                  style={{ width: `${(chart.personalFlow.ingresos / chart.personalFlow.max) * 100}%` }}
                />
              </div>
              <strong>{chart.personalFlow.ingresos}</strong>
            </div>
            <div className="exec-flow-row">
              <span><ArrowUpCircle size={16} /> Egresos</span>
              <div className="exec-flow-track">
                <div
                  className="exec-flow-fill exec-flow-fill--out"
                  style={{ width: `${(chart.personalFlow.egresos / chart.personalFlow.max) * 100}%` }}
                />
              </div>
              <strong>{chart.personalFlow.egresos}</strong>
            </div>
          </div>
          <div className="exec-mini-kpis">
            <div>
              <Activity size={18} />
              <span>{chart.stats.vehiculos}</span>
              <small>Vehículos</small>
            </div>
            <div>
              <Truck size={18} />
              <span>{chart.stats.flota}</span>
              <small>Flota</small>
            </div>
            <div>
              <ClipboardList size={18} />
              <span>{chart.stats.novedades}</span>
              <small>Novedades</small>
            </div>
          </div>
        </article>
      </section>

      <section className="exec-quick">
        <h3>Accesos directos</h3>
        <div className="exec-quick-grid">
          {quickLinks.map(({ id, label, hint, icon: Icon, isAdmin: adminBtn }) => (
            <button
              key={id}
              type="button"
              className={`exec-quick-btn${adminBtn ? ' exec-quick-btn--admin' : ''}`}
              onClick={() => handleNavigate(id)}
            >
              <Icon size={24} />
              <span className="exec-quick-btn__label">{label}</span>
              <span className="exec-quick-btn__hint">{hint}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export default ExecutiveDashboard;
