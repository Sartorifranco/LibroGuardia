import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Settings, LogOut, Sun, Moon, ArrowLeft, Loader2, CloudOff, CircleHelp, KeyRound } from 'lucide-react';
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
import GlobalSearch from './components/GlobalSearch';
import OnboardingTour, { isOnboardingDone } from './components/OnboardingTour';
import ForceChangePasswordModal from './components/ForceChangePasswordModal';
import ChangePasswordForm from './components/ChangePasswordForm';
import { hasPermission, canAccessAdmin } from './utils/permissions';
import { buildSidebarItems } from './utils/navigation';
import { useTheme } from './hooks/useTheme';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { OfflineQueueProvider, useOfflineQueue } from './context/OfflineQueueContext';
import { EntriesProvider, useEntries } from './context/EntriesContext';
import { ClockPrefillProvider, useClockPrefill } from './context/ClockPrefillContext';
import brand from './config/brand';
import LoginPage from './pages/Login/LoginPage';
import HomePage from './pages/Home/HomePage';
import PersonalPage from './pages/Personal/PersonalPage';
import VehiculosExternosPage from './pages/VehiculosExternos/VehiculosExternosPage';
import FlotaInternaPage from './pages/FlotaInterna/FlotaInternaPage';
import NovedadPage from './pages/Novedad/NovedadPage';
import HistorialPage from './pages/Historial/HistorialPage';
import ReportesPage from './pages/Reportes/ReportesPage';
import AdminPage from './pages/Admin/AdminPage';
import { ADMIN_SECTION_META } from './pages/Admin/adminConstants';
import { AccessScanProvider } from './components/GlobalAccessScanner';
import { saveAuthManualPrefill } from './utils/authPrefill';

import './App.css';

// Bug (no corregir): el fetchCurrentUser original omitía handleLogout en deps —
// AuthContext ahora encapsula esa carga de sesión.

/**
 * Shell de la aplicación: layout, navegación y routing por activeTab.
 * Sin formularios ni fetches de dominio.
 */
function AppShell() {
  const { authToken, currentUser, authLoading, logout, changePassword } = useAuth();
  const { error, successMessage, showSuccess, showError, setError, setSuccessMessage } = useToast();
  const { reloadEntries } = useEntries();
  const { pendingCount } = useOfflineQueue();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const { setClockPrefill } = useClockPrefill();
  const { toggleTheme, isDark } = useTheme();

  const [activeTab, setActiveTab] = useState('inicio');
  const [lastOperationalTab, setLastOperationalTab] = useState('inicio');
  const [adminSection, setAdminSection] = useState('users');
  const [authPrefillKey, setAuthPrefillKey] = useState(0);
  const [personalPrefillKey, setPersonalPrefillKey] = useState(0);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourAuto, setTourAuto] = useState(false);

  const handleLogout = useCallback(() => {
    logout();
    setActiveTab('inicio');
    setChangePasswordOpen(false);
  }, [logout]);

  const handleChangePassword = useCallback(async (currentPassword, newPassword) => {
    await changePassword(currentPassword, newPassword);
    setChangePasswordOpen(false);
    showSuccess('Contraseña actualizada');
  }, [changePassword, showSuccess]);

  const mustChangePassword = currentUser?.mustChangePassword === true;

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

  const handleAuthorizeFromScan = useCallback((prefill) => {
    saveAuthManualPrefill(prefill);
    if (prefill?.exceptional) {
      setPersonalPrefillKey((key) => key + 1);
      setActiveTab('personal');
      showSuccess('Completá el ingreso excepcional con el DNI escaneado.');
      return;
    }
    setAuthPrefillKey((key) => key + 1);
    if (activeTab !== 'adminPanel') {
      setLastOperationalTab(activeTab);
    }
    setAdminSection('citaciones');
    setActiveTab('adminPanel');
    showSuccess('Completá la autorización manual con los datos del escaneo.');
  }, [activeTab, showSuccess]);

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

  useEffect(() => {
    if (!currentUser || authLoading) return undefined;
    if (isOnboardingDone()) return undefined;
    setTourAuto(true);
    setTourOpen(true);
    return undefined;
  }, [currentUser, authLoading]);

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

  if (mustChangePassword) {
    return (
      <>
        <ToastStack
          error={error}
          successMessage={successMessage}
          onDismissError={() => setError(null)}
          onDismissSuccess={() => setSuccessMessage(null)}
        />
        <ForceChangePasswordModal
          username={currentUser.username}
          onSubmit={handleChangePassword}
        />
      </>
    );
  }

  if (activeTab === 'kiosk') {
    return (
      <AccessScanProvider
        authToken={authToken}
        currentUser={currentUser}
        paused
        onReloadEntries={() => reloadEntries(true)}
        onAuthorizeManual={handleAuthorizeFromScan}
      >
        <AccessKiosk
          authToken={authToken}
          currentUser={currentUser}
          onExit={() => setActiveTab('inicio')}
          canExceptionalEntry={hasPermission(currentUser, 'access.exceptional_entry')}
        />
      </AccessScanProvider>
    );
  }

  return (
    <AccessScanProvider
      authToken={authToken}
      currentUser={currentUser}
      paused={false}
      onReloadEntries={() => reloadEntries(true)}
      onAuthorizeManual={handleAuthorizeFromScan}
    >
    <div className={`app-shell${isAdminMode ? ' app-shell--admin' : ' app-shell--with-nav'}`}>
      <ToastStack
        error={error}
        successMessage={successMessage}
        onDismissError={() => setError(null)}
        onDismissSuccess={() => setSuccessMessage(null)}
      />
      <OnboardingTour
        open={tourOpen}
        auto={tourAuto}
        onClose={() => {
          setTourOpen(false);
          setTourAuto(false);
        }}
      />
      <div className="main-card app-main-card">
        <header className="app-header app-header-modern">
          <div className="app-header-content">
            <div className="app-header-brand">
              <img src={brand.logoPath} alt={brand.logoAlt} className="auth-logo" />
              <div>
                <h1>{brand.appTitle}</h1>
                <p className="header-subtitle">
                  {isAdminMode
                    ? 'Modo administración — configuración del sistema'
                    : brand.headerSubtitle}
                </p>
              </div>
            </div>
            <div className="app-header-actions">
              {!isAdminMode && (
                <GlobalSearch onNavigate={navigateToTab} />
              )}
              {pendingCount > 0 && (
                <span
                  className="offline-badge"
                  title="Registros pendientes de envío (sin conexión)"
                >
                  <CloudOff size={16} aria-hidden />
                  <span className="offline-badge__count">{pendingCount}</span>
                </span>
              )}
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
              <button
                type="button"
                className="btn-onboarding-link"
                onClick={() => {
                  setTourAuto(false);
                  setTourOpen(true);
                }}
                title="Ver tutorial"
                aria-label="Ver tutorial"
              >
                <CircleHelp size={16} />
                <span className="btn-onboarding-link__label">Ver tutorial</span>
              </button>
              <span className="user-info-tag">
                {currentUser.username} · {currentUser.roleLabel || currentUser.role}
              </span>
              <button
                type="button"
                className="btn-onboarding-link"
                onClick={() => setChangePasswordOpen(true)}
                title="Cambiar mi contraseña"
                aria-label="Cambiar mi contraseña"
                disabled={mustChangePassword}
              >
                <KeyRound size={16} />
                <span className="btn-onboarding-link__label">Mi contraseña</span>
              </button>
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

              {activeTab === 'personal' && <PersonalPage key={personalPrefillKey} />}
              {activeTab === 'vehiculo' && <VehiculosExternosPage />}
              {activeTab === 'flota' && <FlotaInternaPage />}
              {activeTab === 'novedad' && <NovedadPage />}
              {(activeTab === 'historial' || activeTab === 'allRecords') && (
                <HistorialPage />
              )}
              {activeTab === 'reportes' && <ReportesPage />}

              {isAdminMode && canAccessAdmin(currentUser) && (
                <AdminPage
                  adminSection={adminSection}
                  onSectionChange={setAdminSection}
                  onExit={exitAdminPanel}
                  authPrefillKey={authPrefillKey}
                />
              )}
            </main>
          </div>
        </div>
      </div>
    </div>
    {changePasswordOpen && (
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <div className="modal-content change-password-modal">
          <h2 id="change-password-title" className="auth-title" style={{ fontSize: '1.2rem', marginTop: 0 }}>
            Cambiar mi contraseña
          </h2>
          <ChangePasswordForm
            onSubmit={handleChangePassword}
            onCancel={() => setChangePasswordOpen(false)}
          />
        </div>
      </div>
    )}
    </AccessScanProvider>
  );
}

function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <OfflineQueueProvider>
            <EntriesProvider>
              <ClockPrefillProvider>
                <AppShell />
              </ClockPrefillProvider>
            </EntriesProvider>
          </OfflineQueueProvider>
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

export default App;
