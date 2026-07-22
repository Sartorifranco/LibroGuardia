import React, { useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useNavigate,
  useParams,
  Link
} from 'react-router-dom';
import { Settings, LogOut, Sun, Moon, ArrowLeft, CloudOff, CircleHelp, KeyRound } from 'lucide-react';
import AccessKiosk from './components/AccessKiosk';
import ToastStack from './components/ToastStack';
import AppSidebar from './components/AppSidebar';
import LiveClockBar from './components/LiveClockBar';
import GuardAuthorizationsPanel from './components/GuardAuthorizationsPanel';
import FleetGatePanel from './components/FleetGatePanel';
import CitadosPanel from './components/CitadosPanel';
import MonitoringVehiclesPanel from './components/MonitoringVehiclesPanel';
import DigitalDoorPanel from './components/DigitalDoorPanel';
import GlobalSearch from './components/GlobalSearch';
import OnboardingTour from './components/OnboardingTour';
import ForceChangePasswordModal from './components/ForceChangePasswordModal';
import ChangePasswordForm from './components/ChangePasswordForm';
import { hasPermission, canAccessAdmin, canAccessGuardia, canAccessEmpleado } from './utils/permissions';
import {
  guardiaPath,
  adminPath,
  tabFromGuardiaSegment,
  sectionFromAdminSegment,
  getDefaultAdminSection,
  resolveHomePath,
  GUARDIA_SEGMENT_TO_TAB
} from './utils/navigation';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { OfflineQueueProvider } from './context/OfflineQueueContext';
import { EntriesProvider } from './context/EntriesContext';
import { ClockPrefillProvider } from './context/ClockPrefillContext';
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
import ModeSelectPage from './pages/ModeSelect/ModeSelectPage';
import EmpleadoRegistroPage from './pages/Empleado/EmpleadoRegistroPage';
import EmpleadoVisitasPage from './pages/Empleado/EmpleadoVisitasPage';
import { ADMIN_SECTION_META } from './pages/Admin/adminConstants';
import { AccessScanProvider } from './components/GlobalAccessScanner';
import LiveAlertsToaster from './components/LiveAlertsToaster';
import {
  RequireAuth,
  RequireGuardia,
  RequireAdmin,
  RequireEmpleado,
  AuthLoadingScreen
} from './routing/RouteGuards';
import { AppChromeProvider, useAppChrome } from './routing/AppChromeContext';

import './App.css';
import './pages/Empleado/empleado.css';

function AppHeader({ isAdminMode, activeAdminMeta }) {
  const chrome = useAppChrome();
  const {
    currentUser,
    pendingCount,
    toggleTheme,
    isDark,
    navigateToTab,
    enterAdminPanel,
    exitAdminPanel,
    handleLogout,
    setTourOpen,
    setTourAuto,
    setChangePasswordOpen,
    mustChangePassword
  } = chrome;

  return (
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
            isAdminMode ? (
              <button
                type="button"
                className="btn-admin-panel is-active"
                onClick={exitAdminPanel}
              >
                <ArrowLeft size={16} /> Volver a operación
              </button>
            ) : (
              <button
                type="button"
                className="btn-admin-panel"
                onClick={enterAdminPanel}
              >
                <Settings size={16} /> Panel admin
              </button>
            )
          )}
          {canAccessGuardia(currentUser) && canAccessAdmin(currentUser) && (
            <Link to="/" className="btn-onboarding-link" title="Cambiar de área">
              Áreas
            </Link>
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
      {isAdminMode && activeAdminMeta ? (
        <span className="sr-only">{activeAdminMeta.title}</span>
      ) : null}
    </header>
  );
}

function ChangePasswordOverlay({ open, onSubmit, onCancel }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
      <div className="modal-content change-password-modal">
        <h2 id="change-password-title" className="auth-title" style={{ fontSize: '1.2rem', marginTop: 0 }}>
          Cambiar mi contraseña
        </h2>
        <ChangePasswordForm onSubmit={onSubmit} onCancel={onCancel} />
      </div>
    </div>
  );
}

function ForcePasswordGate({ children }) {
  const {
    currentUser,
    mustChangePassword,
    error,
    successMessage,
    setError,
    setSuccessMessage,
    handleChangePassword
  } = useAppChrome();

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
  return children;
}

function GuardiaLayout() {
  const chrome = useAppChrome();
  const { tabSegment } = useParams();

  if (!GUARDIA_SEGMENT_TO_TAB[tabSegment]) {
    return <Navigate to={guardiaPath('inicio')} replace />;
  }

  const activeTab = tabFromGuardiaSegment(tabSegment);
  const {
    authToken,
    currentUser,
    error,
    successMessage,
    setError,
    setSuccessMessage,
    reloadEntries,
    handleAuthorizeFromScan,
    navigateToTab,
    enterAdminPanel,
    sidebarItems,
    handleGpsMovementsRegistered,
    applyCurrentTime,
    copyCurrentTime,
    tourOpen,
    tourAuto,
    setTourOpen,
    setTourAuto,
    changePasswordOpen,
    setChangePasswordOpen,
    handleChangePassword,
    personalPrefillKey,
    handleAttendanceRegistered,
    showSuccess,
    showError
  } = chrome;

  if (activeTab === 'kiosk') {
    return (
      <ForcePasswordGate>
        <AccessScanProvider
          authToken={authToken}
          currentUser={currentUser}
          paused
          onReloadEntries={() => reloadEntries(true)}
          onAuthorizeManual={handleAuthorizeFromScan}
        >
          <LiveAlertsToaster />
          <AccessKiosk
            authToken={authToken}
            currentUser={currentUser}
            onExit={() => navigateToTab('inicio')}
            canExceptionalEntry={hasPermission(currentUser, 'access.exceptional_entry')}
          />
        </AccessScanProvider>
      </ForcePasswordGate>
    );
  }

  return (
    <ForcePasswordGate>
      <AccessScanProvider
        authToken={authToken}
        currentUser={currentUser}
        paused={false}
        onReloadEntries={() => reloadEntries(true)}
        onAuthorizeManual={handleAuthorizeFromScan}
      >
        <LiveAlertsToaster />
        <div className="app-shell app-shell--with-nav">
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
            <AppHeader isAdminMode={false} />
            <div className="app-layout">
              <AppSidebar
                activeTab={activeTab}
                onNavigate={navigateToTab}
                onEnterAdmin={enterAdminPanel}
                showAdmin={canAccessAdmin(currentUser)}
                items={sidebarItems}
              />
              <div className="app-content">
                {activeTab !== 'inicio' && hasPermission(currentUser, 'fleet.gps.read') && (
                  <FleetGatePanel
                    authToken={authToken}
                    enabled
                    compact
                    pollSeconds={20}
                    onMovementRegistered={handleGpsMovementsRegistered}
                  />
                )}
                {['personal', 'vehiculo', 'flota', 'novedad'].includes(activeTab) && (
                  <LiveClockBar
                    activeTab={activeTab}
                    onApplyTime={(timeValue) => applyCurrentTime(timeValue, activeTab)}
                    onCopyTime={copyCurrentTime}
                  />
                )}
                <main className="app-main-inner">
                  {activeTab === 'inicio' && (
                    <HomePage onNavigate={navigateToTab} onEnterAdmin={enterAdminPanel} />
                  )}
                  {activeTab === 'vehiculosAutorizados' && (
                    hasPermission(currentUser, 'monitoring.vehicles.manage')
                    || hasPermission(currentUser, 'master.vehicles.quick_authorize')
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
                  {activeTab === 'botoneraMonitoreo' && hasPermission(currentUser, 'monitoring.doors.panel') && (
                    <div className="form-section">
                      <DigitalDoorPanel profile="monitoreo" canManualOpen={hasPermission(currentUser, 'access.manual_open')} />
                    </div>
                  )}
                  {activeTab === 'botoneraGuardia' && hasPermission(currentUser, 'guard.doors.panel') && (
                    <div className="form-section">
                      <DigitalDoorPanel profile="guardia" canManualOpen={hasPermission(currentUser, 'access.manual_open')} />
                    </div>
                  )}
                  {activeTab === 'citados' && hasPermission(currentUser, 'attendance.alerts.read') && (
                    <div className="form-section">
                      <CitadosPanel
                        authToken={authToken}
                        enabled
                        pollSeconds={60}
                        onRegistered={handleAttendanceRegistered}
                      />
                    </div>
                  )}
                  {activeTab === 'autorizados' && hasPermission(currentUser, 'master.citaciones.read') && (
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
                  {(activeTab === 'historial' || activeTab === 'allRecords') && <HistorialPage />}
                  {activeTab === 'reportes' && <ReportesPage />}
                </main>
              </div>
            </div>
          </div>
        </div>
        <ChangePasswordOverlay
          open={changePasswordOpen}
          onSubmit={handleChangePassword}
          onCancel={() => setChangePasswordOpen(false)}
        />
      </AccessScanProvider>
    </ForcePasswordGate>
  );
}

function AdminLayout() {
  const chrome = useAppChrome();
  const navigate = useNavigate();
  const { sectionSegment } = useParams();
  const {
    authToken,
    currentUser,
    error,
    successMessage,
    setError,
    setSuccessMessage,
    reloadEntries,
    handleAuthorizeFromScan,
    exitAdminPanel,
    tourOpen,
    tourAuto,
    setTourOpen,
    setTourAuto,
    changePasswordOpen,
    setChangePasswordOpen,
    handleChangePassword,
    authPrefillKey
  } = chrome;

  const resolvedSection = sectionFromAdminSegment(sectionSegment);
  const adminSection = resolvedSection || getDefaultAdminSection(currentUser);
  const activeAdminMeta = ADMIN_SECTION_META[adminSection] || { title: 'Administración', description: '' };

  useEffect(() => {
    if (!resolvedSection) {
      navigate(adminPath(getDefaultAdminSection(currentUser)), { replace: true });
    }
  }, [resolvedSection, currentUser, navigate]);

  return (
    <ForcePasswordGate>
      <AccessScanProvider
        authToken={authToken}
        currentUser={currentUser}
        paused={false}
        onReloadEntries={() => reloadEntries(true)}
        onAuthorizeManual={handleAuthorizeFromScan}
      >
        <div className="app-shell app-shell--admin">
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
            <AppHeader isAdminMode activeAdminMeta={activeAdminMeta} />
            <div className="app-layout">
              <div className="app-content">
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
                <main className="app-main-inner">
                  {resolvedSection && (
                    <AdminPage
                      adminSection={adminSection}
                      onSectionChange={(id) => navigate(adminPath(id))}
                      onExit={exitAdminPanel}
                      authPrefillKey={authPrefillKey}
                    />
                  )}
                </main>
              </div>
            </div>
          </div>
        </div>
        <ChangePasswordOverlay
          open={changePasswordOpen}
          onSubmit={handleChangePassword}
          onCancel={() => setChangePasswordOpen(false)}
        />
      </AccessScanProvider>
    </ForcePasswordGate>
  );
}

function GuardiaIndexRedirect() {
  return <Navigate to={guardiaPath('inicio')} replace />;
}

function AdminIndexRedirect() {
  const { currentUser } = useAuth();
  return <Navigate to={adminPath(getDefaultAdminSection(currentUser))} replace />;
}

function LoginRoute() {
  const { currentUser, authLoading } = useAuth();
  if (authLoading) return <AuthLoadingScreen />;
  if (currentUser) {
    return <Navigate to={resolveHomePath(currentUser)} replace />;
  }
  return <LoginPage />;
}

function EmpleadoLoginRoute() {
  const { currentUser, authLoading } = useAuth();
  if (authLoading) return <AuthLoadingScreen />;
  if (currentUser) {
    return <Navigate to={resolveHomePath(currentUser)} replace />;
  }
  return <LoginPage variant="empleado" />;
}

function EmpleadoIndexRedirect() {
  return <Navigate to="/empleado/visitas" replace />;
}

function ModeSelectRoute() {
  const { currentUser } = useAuth();
  const guardia = canAccessGuardia(currentUser);
  const admin = canAccessAdmin(currentUser);
  if (canAccessEmpleado(currentUser) && !guardia && !admin) {
    return <Navigate to="/empleado" replace />;
  }
  if (guardia && admin) return <ModeSelectPage />;
  return <Navigate to={resolveHomePath(currentUser)} replace />;
}

function AuthenticatedShell() {
  return (
    <AppChromeProvider>
      <Outlet />
    </AppChromeProvider>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/empleado/registro" element={<EmpleadoRegistroPage />} />
      <Route path="/empleado/login" element={<EmpleadoLoginRoute />} />
      <Route
        path="/empleado"
        element={(
          <RequireAuth>
            <Outlet />
          </RequireAuth>
        )}
      >
        <Route index element={<EmpleadoIndexRedirect />} />
        <Route
          path="visitas"
          element={(
            <RequireEmpleado>
              <EmpleadoVisitasPage />
            </RequireEmpleado>
          )}
        />
      </Route>
      <Route
        path="/"
        element={(
          <RequireAuth>
            <AuthenticatedShell />
          </RequireAuth>
        )}
      >
        <Route index element={<ModeSelectRoute />} />
        <Route
          path="guardia"
          element={(
            <RequireGuardia>
              <Outlet />
            </RequireGuardia>
          )}
        >
          <Route index element={<GuardiaIndexRedirect />} />
          <Route path=":tabSegment" element={<GuardiaLayout />} />
        </Route>
        <Route
          path="admin"
          element={(
            <RequireAdmin>
              <Outlet />
            </RequireAdmin>
          )}
        >
          <Route index element={<AdminIndexRedirect />} />
          <Route path=":sectionSegment" element={<AdminLayout />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <OfflineQueueProvider>
              <EntriesProvider>
                <ClockPrefillProvider>
                  <AppRoutes />
                </ClockPrefillProvider>
              </EntriesProvider>
            </OfflineQueueProvider>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
