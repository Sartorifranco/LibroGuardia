import React, { useCallback } from 'react';
import ExecutiveDashboard from '../../components/dashboards/ExecutiveDashboard';
import GuardiaDashboard from '../../components/dashboards/GuardiaDashboard';
import MonitoreoDashboard from '../../components/dashboards/MonitoreoDashboard';
import { useAuth } from '../../context/AuthContext';
import { useEntries } from '../../context/EntriesContext';
import { useToast } from '../../context/ToastContext';
import { getDashboardProfile, hasPermission } from '../../utils/permissions';

/**
 * Dashboard de inicio — lógica de renderHomeDashboard.
 */
function HomePage({ onNavigate, onEnterAdmin }) {
  const { authToken, currentUser } = useAuth();
  const { entries, reloadEntries } = useEntries();
  const { showSuccess } = useToast();

  const handleAttendanceRegistered = useCallback((item) => {
    showSuccess(`Ingreso registrado: ${item?.name || 'personal'}`);
    reloadEntries(true);
  }, [reloadEntries, showSuccess]);

  const handleGpsMovementsRegistered = useCallback((items = []) => {
    if (!items.length) return;
    const summary = items
      .map((item) => `${item.directionLabel || item.direction}: ${item.plate || item.name}`)
      .join(' · ');
    showSuccess(`GPS registró ${items.length} movimiento(s): ${summary}`);
    reloadEntries(true);
  }, [reloadEntries, showSuccess]);

  const dashboardProfile = getDashboardProfile(currentUser);

  if (dashboardProfile === 'monitoreo') {
    return (
      <MonitoreoDashboard
        currentUser={currentUser}
        entries={entries}
        onNavigate={onNavigate}
      />
    );
  }
  if (dashboardProfile === 'guardia') {
    return (
      <GuardiaDashboard
        currentUser={currentUser}
        entries={entries}
        onNavigate={onNavigate}
        authToken={authToken}
        showFleetGps={hasPermission(currentUser, 'fleet.gps.read')}
        showAttendanceAlerts={hasPermission(currentUser, 'attendance.alerts.read')}
        showCitados={hasPermission(currentUser, 'attendance.alerts.read')}
        onGpsMovementRegistered={handleGpsMovementsRegistered}
        onAttendanceRegistered={handleAttendanceRegistered}
      />
    );
  }
  if (dashboardProfile === 'supervisor' || dashboardProfile === 'admin') {
    return (
      <ExecutiveDashboard
        currentUser={currentUser}
        entries={entries}
        isAdmin={dashboardProfile === 'admin'}
        onNavigate={(tab) => {
          if (tab === 'adminPanel') onEnterAdmin();
          else onNavigate(tab);
        }}
      />
    );
  }
  return (
    <GuardiaDashboard
      currentUser={currentUser}
      entries={entries}
      onNavigate={onNavigate}
      authToken={authToken}
      showFleetGps={hasPermission(currentUser, 'fleet.gps.read')}
      showAttendanceAlerts={hasPermission(currentUser, 'attendance.alerts.read')}
      showCitados={hasPermission(currentUser, 'attendance.alerts.read')}
      onGpsMovementRegistered={handleGpsMovementsRegistered}
      onAttendanceRegistered={handleAttendanceRegistered}
    />
  );
}

export default HomePage;
