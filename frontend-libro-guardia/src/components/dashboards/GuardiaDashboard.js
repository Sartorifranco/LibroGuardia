import React, { useMemo } from 'react';
import {
  User,
  Truck,
  ClipboardList,
  Scan,
  ArrowDownCircle,
  ArrowUpCircle,
  Activity
} from 'lucide-react';
import { useLiveClock } from '../../hooks/useLiveClock';
import DashboardShell from './DashboardShell';
import FleetGatePanel from '../FleetGatePanel';
import AttendanceMissingPanel from '../AttendanceMissingPanel';
import CitadosPanel from '../CitadosPanel';
import { getDashboardStats } from '../../utils/dashboardStats';

function GuardiaDashboard({
  currentUser,
  entries,
  onNavigate,
  authToken,
  showFleetGps,
  showAttendanceAlerts,
  showCitados,
  onGpsMovementRegistered,
  onAttendanceRegistered,
}) {
  const { timeInputValue } = useLiveClock();
  const stats = useMemo(() => getDashboardStats(entries), [entries]);

  return (
    <DashboardShell
      currentUser={currentUser}
      entries={entries}
      onNavigate={(tab) => onNavigate(tab, timeInputValue)}
      title={`Guardia — ${currentUser.username}`}
      subtitle="Portón blindados, acceso principal a planta y control de personal"
      panels={(
        <>
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
        </>
      )}
      kpis={[
        { label: 'Movimientos hoy', value: stats.totalToday, icon: Activity, accent: true },
        { label: 'Ingresos personal', value: stats.personalIngresos, icon: ArrowDownCircle },
        { label: 'Egresos personal', value: stats.personalEgresos, icon: ArrowUpCircle },
        { label: 'Blindados / flota', value: stats.flota, icon: Truck },
        { label: 'Novedades', value: stats.novedades, icon: ClipboardList }
      ]}
      quickActions={[
        { id: 'personal', label: 'Registrar personal', icon: User },
        { id: 'flota', label: 'Unidad blindada', icon: Truck },
        { id: 'kiosk', label: 'Molinete / acceso', icon: Scan },
        { id: 'novedad', label: 'Cargar novedad', icon: ClipboardList }
      ]}
    />
  );
}

export default GuardiaDashboard;
