import React, { useMemo } from 'react';
import { Car, ClipboardList, DoorOpen } from 'lucide-react';
import DashboardShell from './DashboardShell';
import { getDashboardStats } from '../../utils/dashboardStats';
import { getEffectiveEntryType } from '../../utils/entryDisplay';

function MonitoreoDashboard({ currentUser, entries, onNavigate }) {
  const stats = useMemo(() => getDashboardStats(entries), [entries]);
  const monitoreoEntries = useMemo(
    () => entries.filter((entry) =>
      getEffectiveEntryType(entry) === 'vehiculo'
      || entry.type === 'novedad'
      || entry.gateProfile === 'monitoreo'
    ).slice(0, 8),
    [entries]
  );

  return (
    <DashboardShell
      currentUser={currentUser}
      entries={entries}
      onNavigate={onNavigate}
      title={`Monitoreo — ${currentUser.username}`}
      subtitle="Portón de vehículos livianos, directivos, clientes y grúas"
      kpis={[
        { label: 'Vehículos hoy', value: stats.vehiculos, icon: Car },
        { label: 'Novedades hoy', value: stats.novedades, icon: ClipboardList },
        { label: 'Movimientos hoy', value: stats.totalToday, icon: DoorOpen, accent: true }
      ]}
      quickActions={[
        { id: 'vehiculosAutorizados', label: 'Autorizar vehículo', icon: Car },
        { id: 'novedad', label: 'Cargar novedad', icon: ClipboardList },
        { id: 'botoneraMonitoreo', label: 'Botonera portón', icon: DoorOpen }
      ]}
      recentEntries={monitoreoEntries}
    />
  );
}

export default MonitoreoDashboard;
