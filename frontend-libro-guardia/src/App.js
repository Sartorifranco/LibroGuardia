import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Settings, LogOut, Sun, Moon, ArrowLeft, Loader2 } from 'lucide-react';
import AccessKiosk from './components/AccessKiosk';
import ToastStack from './components/ToastStack';
import AppSidebar from './components/AppSidebar';
import LiveClockBar from './components/LiveClockBar';
import GuardAuthorizationsPanel from './components/GuardAuthorizationsPanel';
import FleetGatePanel from './components/FleetGatePanel';
import CitadosPanel from './components/CitadosPanel';
import ManualDoorButton from './components/ManualDoorButton';
import MonitoringVehiclesPanel from './components/MonitoringVehiclesPanel';
import DigitalDoorPanel from './components/DigitalDoorPanel';
import { hasPermission, canAccessAdmin } from './utils/permissions';
import { buildSidebarItems } from './utils/navigation';
import { useTheme } from './hooks/useTheme';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { EntriesProvider, useEntries } from './context/EntriesContext';
import { ClockPrefillProvider, useClockPrefill } from './context/ClockPrefillContext';
import { apiFetch } from './services/api';
import LoginPage from './pages/Login/LoginPage';
import HomePage from './pages/Home/HomePage';
import PersonalPage from './pages/Personal/PersonalPage';
import VehiculosExternosPage from './pages/VehiculosExternos/VehiculosExternosPage';
import FlotaInternaPage from './pages/FlotaInterna/FlotaInternaPage';
import NovedadPage from './pages/Novedad/NovedadPage';
import HistorialPage from './pages/Historial/HistorialPage';
import AdminPage from './pages/Admin/AdminPage';
import { ADMIN_SECTION_META } from './pages/Admin/adminConstants';

import './App.css';

// Bug (no corregir): el fetchCurrentUser original omitía handleLogout en deps —
// AuthContext ahora encapsula esa carga de sesión.

/**
 * Shell de la aplicación: layout, navegación y routing por activeTab.
 * Sin formularios ni fetches de dominio (salvo kioskResetSeconds).
 */
function AppShell() {
  const { authToken, currentUser, authLoading, logout } = useAuth();
  const { error, successMessage, showSuccess, showError, setError, setSuccessMessage } = useToast();
  const { reloadEntries } = useEntries();
  const { setClockPrefill } = useClockPrefill();
  const { toggleTheme, isDark } = useTheme();

  const [activeTab, setActiveTab] = useState('inicio');
  const [lastOperationalTab, setLastOperationalTab] = useState('inicio');
  const [adminSection, setAdminSection] = useState('users');
  const [kioskResetSeconds, setKioskResetSeconds] = useState(4);

  useEffect(() => {
    if (!currentUser || !authToken) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch('/admin/access-control', {
          token: authToken,
          allowForbidden: true
        });
        if (!cancelled && data.config?.kioskResetSeconds != null) {
          setKioskResetSeconds(data.config.kioskResetSeconds || 4);
        }
      } catch {
        // Sin permiso: default 4
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser, authToken]);

  const handleLogout = useCallback(() => {
    logout();
    setActiveTab('inicio');
  }, [logout]);

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

  const sidebarItems = useMemo(
    () => (currentUser ? buildSidebarItems(currentUser) : []),
    [currentUser]
  );

  const activeAdminMeta = ADMIN_SECTION_META[adminSection] || { title: 'Administración', description: '' };
  const isAdminMode = activeTab === 'adminPanel';

  const enterAdminPanel = useCallback(() => {
    if (activeTab !== 'adminPanel') {
      setLastOperationalTab(activeTab);
    }
    setActiveTab('adminPanel');
  }, [activeTab]);

  const exitAdminPanel = useCallback(() => {
    setActiveTab(lastOperationalTab || 'inicio');
  }, [lastOperationalTab]);

  const navigateToTab = useCallback((tab, timeValue) => {
    if (tab === 'kiosk') {
      setActiveTab('kiosk');
      return;
    }
    setActiveTab(tab);
    if (timeValue) {
      setClockPrefill(tab, timeValue);
    }
  }, [setClockPrefill]);

  const applyCurrentTime = useCallback((timeValue) => {
    if (['personal', 'vehiculo', 'flota', 'novedad'].includes(activeTab)) {
      setClockPrefill(activeTab, timeValue);
      const labels = {
        personal: 'registro de personal',
        vehiculo: 'registro de vehículo',
        flota: 'registro de flota',
        novedad: 'novedad',
      };
      showSuccess(`Hora ${timeValue} cargada en ${labels[activeTab]}.`);
    }
  }, [activeTab, setClockPrefill, showSuccess]);

  const copyCurrentTime = useCallback(async (timeValue, dateLabel) => {
    try {
      await navigator.clipboard.writeText(`${timeValue} — ${dateLabel}`);
      showSuccess(`Hora copiada: ${timeValue}`);
    } catch {
      showError('No se pudo copiar la hora al portapapeles.');
    }
  }, [showSuccess, showError]);

  if (authLoading) {
    return (
      <div className="loading-screen">
        <div className="flex items-center space-x-2">
          <Loader2 className="animate-spin" size={24} />
          <span>Cargando aplicación...</span>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage />;
  }

  if (activeTab === 'kiosk') {
    return (
      <AccessKiosk
        authToken={authToken}
        currentUser={currentUser}
        onExit={() => setActiveTab('inicio')}
        resetSeconds={kioskResetSeconds || 4}
        canExceptionalEntry={hasPermission(currentUser, 'access.exceptional_entry')}
      />
    );
  }

  return (
    <div className={`app-shell${isAdminMode ? ' app-shell--admin' : ' app-shell--with-nav'}`}>
      <ToastStack
        error={error}
        successMessage={successMessage}
        onDismissError={() => setError(null)}
        onDismissSuccess={() => setSuccessMessage(null)}
      />
      <div className="main-card app-main-card">
        <header className="app-header app-header-modern">
          <div className="app-header-content">
            <div className="app-header-brand">
              <img src="B roja.png" alt="Logo Bacar" className="auth-logo" />
              <div>
                <h1>Libro de Guardia</h1>
                <p className="header-subtitle">
                  {isAdminMode
                    ? 'Modo administración — configuración del sistema'
                    : 'Bacar S.A. — Control de accesos y novedades'}
                </p>
              </div>
            </div>
            <div className="app-header-actions">
              <ManualDoorButton
                authToken={authToken}
                currentUser={currentUser}
                onSuccess={showSuccess}
                onError={showError}
              />
              <button
                type="button"
                className="theme-toggle-btn"
                onClick={toggleTheme}
                aria-label={isDark ? 'Activar modo claro' : 'Activar modo oscuro'}
                title={isDark ? 'Modo claro' : 'Modo oscuro'}
              >
                {isDark ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <span className="user-info-tag">
                {currentUser.username} · {currentUser.roleLabel || currentUser.role}
              </span>
              {canAccessAdmin(currentUser) && (
                <button
                  type="button"
                  className={`btn-admin-panel${isAdminMode ? ' is-active' : ''}`}
                  onClick={isAdminMode ? exitAdminPanel : enterAdminPanel}
                >
                  {isAdminMode ? (
                    <><ArrowLeft size={16} /> Volver a operación</>
                  ) : (
                    <><Settings size={16} /> Panel admin</>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="btn-logout-link"
              >
                <LogOut size={16} /> Salir
              </button>
            </div>
          </div>
        </header>

        <div className="app-layout">
          {!isAdminMode && (
            <AppSidebar
              activeTab={activeTab}
              onNavigate={navigateToTab}
              onEnterAdmin={enterAdminPanel}
              showAdmin={canAccessAdmin(currentUser)}
              items={sidebarItems}
            />
          )}

          <div className="app-content">
            {!isAdminMode && activeTab !== 'inicio' && hasPermission(currentUser, 'fleet.gps.read') && (
              <FleetGatePanel
                authToken={authToken}
                enabled
                compact
                pollSeconds={20}
                onMovementRegistered={handleGpsMovementsRegistered}
              />
            )}
            {isAdminMode ? (
              <div className="admin-mode-bar">
                <button type="button" className="admin-mode-back" onClick={exitAdminPanel}>
                  <ArrowLeft size={18} /> Volver a operación de guardia
                </button>
                <div className="admin-mode-breadcrumb">
                  <span>Operación</span>
                  <span className="admin-mode-sep">/</span>
                  <span className="admin-mode-current">Administración</span>
                  <span className="admin-mode-sep">/</span>
                  <span className="admin-mode-current">{activeAdminMeta.title}</span>
                </div>
              </div>
            ) : (
              ['personal', 'vehiculo', 'flota', 'novedad'].includes(activeTab) && (
                <LiveClockBar
                  activeTab={activeTab}
                  onApplyTime={applyCurrentTime}
                  onCopyTime={copyCurrentTime}
                />
              )
            )}

            <main className="app-main-inner">
              {activeTab === 'inicio' && !isAdminMode && (
                <HomePage onNavigate={navigateToTab} onEnterAdmin={enterAdminPanel} />
              )}

              {activeTab === 'vehiculosAutorizados' && !isAdminMode && (
                hasPermission(currentUser, 'monitoring.vehicles.manage') || hasPermission(currentUser, 'master.vehicles.quick_authorize')
              ) && (
                <div className="form-section">
                  <MonitoringVehiclesPanel
                    authToken={authToken}
                    onSuccess={showSuccess}
                    onError={showError}
                    onMovementRegistered={() => reloadEntries(true)}
                  />
                </div>
              )}

              {activeTab === 'botoneraMonitoreo' && !isAdminMode && hasPermission(currentUser, 'monitoring.doors.panel') && (
                <div className="form-section">
                  <DigitalDoorPanel profile="monitoreo" canManualOpen={hasPermission(currentUser, 'access.manual_open')} />
                </div>
              )}

              {activeTab === 'botoneraGuardia' && !isAdminMode && hasPermission(currentUser, 'guard.doors.panel') && (
                <div className="form-section">
                  <DigitalDoorPanel profile="guardia" canManualOpen={hasPermission(currentUser, 'access.manual_open')} />
                </div>
              )}

              {activeTab === 'citados' && !isAdminMode && hasPermission(currentUser, 'attendance.alerts.read') && (
                <div className="form-section">
                  <CitadosPanel
                    authToken={authToken}
                    enabled
                    pollSeconds={60}
                    onRegistered={handleAttendanceRegistered}
                  />
                </div>
              )}

              {activeTab === 'autorizados' && !isAdminMode && hasPermission(currentUser, 'master.citaciones.read') && (
                <div className="form-section">
                  <GuardAuthorizationsPanel
                    authToken={authToken}
                    canPreRegister={hasPermission(currentUser, 'master.citaciones.preregister')}
                    onSuccess={showSuccess}
                    onError={showError}
                  />
                </div>
              )}

              {activeTab === 'personal' && <PersonalPage />}
              {activeTab === 'vehiculo' && <VehiculosExternosPage />}
              {activeTab === 'flota' && <FlotaInternaPage />}
              {activeTab === 'novedad' && <NovedadPage />}
              {(activeTab === 'historial' || activeTab === 'reportes' || activeTab === 'allRecords') && (
                <HistorialPage />
              )}

              {isAdminMode && canAccessAdmin(currentUser) && (
                <AdminPage
                  adminSection={adminSection}
                  onSectionChange={setAdminSection}
                  onExit={exitAdminPanel}
                  onAccessConfigSaved={(cfg) => {
                    if (cfg?.kioskResetSeconds != null) {
                      setKioskResetSeconds(cfg.kioskResetSeconds || 4);
                    }
                  }}
                />
              )}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <EntriesProvider>
          <ClockPrefillProvider>
            <AppShell />
          </ClockPrefillProvider>
        </EntriesProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

export default App;
