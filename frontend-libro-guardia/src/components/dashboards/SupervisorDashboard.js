import React, { useMemo } from 'react';
import {
  User,
  Car,
  Truck,
  ClipboardList,
  Users,
  Activity,
  Shield
} from 'lucide-react';
import DashboardShell from './DashboardShell';
import FleetGatePanel from '../FleetGatePanel';
import AttendanceMissingPanel from '../AttendanceMissingPanel';
import { getDashboardStats } from '../../utils/dashboardStats';

function SupervisorDashboard({
  currentUser,
  entries,
  onNavigate,
  authToken,
  showFleetGps,
  showAttendanceAlerts,
  onGpsMovementRegistered,
  onAttendanceRegistered
}) {
  const stats = useMemo(() => getDashboardStats(entries), [entries]);

  return (
    <DashboardShell
      currentUser={currentUser}
      entries={entries}
      onNavigate={onNavigate}
      title={`Supervisión — ${currentUser.username}`}
      subtitle="Vista consolidada de Guardia, Monitoreo y operación del día"
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
        { label: 'Personal ingresos', value: stats.personalIngresos, icon: User },
        { label: 'Vehículos externos', value: stats.vehiculos, icon: Car },
        { label: 'Flota / blindados', value: stats.flota, icon: Truck },
        { label: 'Novedades', value: stats.novedades, icon: ClipboardList },
        { label: 'Usuarios activos', value: '—', icon: Users }
      ]}
      quickActions={[
        { id: 'personal', label: 'Personal', icon: User },
        { id: 'vehiculosAutorizados', label: 'Vehículos Monitoreo', icon: Car },
        { id: 'flota', label: 'Blindados', icon: Truck },
        { id: 'novedad', label: 'Novedad', icon: ClipboardList },
        { id: 'adminPanel', label: 'Panel operativo', icon: Shield }
      ]}
    />
  );
}

export default SupervisorDashboard;
