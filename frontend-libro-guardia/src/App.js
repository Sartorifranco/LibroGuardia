import React, { useEffect, useState, Suspense } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useNavigate,
  useParams,
  useLocation,
  Link
} from 'react-router-dom';
import { Settings, LogOut, Sun, Moon, ArrowLeft, CloudOff, CircleHelp, KeyRound, Menu, X } from 'lucide-react';
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
import BotoneraPopupPage from './pages/Guardia/BotoneraPopupPage';
import { openBotoneraWindow } from './utils/openBotoneraWindow';
import { hasPermission, canAccessAdmin, canAccessGuardia, canAccessEmpleado, displayRoleLabel } from './utils/permissions';
import {
  guardiaPath,
  adminPath,
  tabFromGuardiaSegment,
  sectionFromAdminSegment,
  getDefaultAdminSection,
  resolveHomePath,
  GUARDIA_SEGMENT_TO_TAB,
  isLanFeatureAllowed
} from './utils/navigation';
import { AuthProvider, useAuth } from './context/AuthContext';
import { useOfflineQueue } from './context/OfflineQueueContext';
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { OfflineQueueProvider } from './context/OfflineQueueContext';
import { EntriesProvider } from './context/EntriesContext';
import { ClockPrefillProvider } from './context/ClockPrefillContext';
import { RuntimeProvider, useRuntime } from './context/RuntimeContext';
import { HubLiveProvider } from './context/HubLiveContext';
import { GuardAlarmsProvider } from './context/GuardAlarmsContext';
import brand from './config/brand';
import LoginPage from './pages/Login/LoginPage';
import HomePage from './pages/Home/HomePage';
import PersonalPage from './pages/Personal/PersonalPage';
import AutorizacionesPage from './pages/Autorizaciones/AutorizacionesPage';
import VehiculosExternosPage from './pages/VehiculosExternos/VehiculosExternosPage';
import FlotaInternaPage from './pages/FlotaInterna/FlotaInternaPage';
import NovedadPage from './pages/Novedad/NovedadPage';
import HistorialPage from './pages/Historial/HistorialPage';
import { ADMIN_SECTION_META } from './pages/Admin/adminConstants';
import ModeSelectPage from './pages/ModeSelect/ModeSelectPage';
import EmpleadoRegistroPage from './pages/Empleado/EmpleadoRegistroPage';
import EmpleadoVisitasPage from './pages/Empleado/EmpleadoVisitasPage';
import VisitaInvitacionPage from './pages/Empleado/VisitaInvitacionPage';
import { AccessScanProvider } from './components/GlobalAccessScanner';
import LiveAlertsToaster from './components/LiveAlertsToaster';
import RuntimeModeBadge from './components/RuntimeModeBadge';
import LanUnavailable from './components/LanUnavailable';
import CriticalAlarmBanner from './components/CriticalAlarmBanner';
import GuardAlarmsPanel from './components/GuardAlarmsPanel';
import {
  RequireAuth,
  RequireGuardia,
  RequireAdmin,
  RequireEmpleado,
  AuthLoadingScreen
} from './routing/RouteGuards';
import { AppChromeProvider, useAppChrome } from './routing/AppChromeContext';
import ConnectivityChrome from './components/ConnectivityChrome';

import './App.css';
import './pages/Empleado/empleado.css';

const AdminPage = React.lazy(() => import('./pages/Admin/AdminPage'));
const ReportesPage = React.lazy(() => import('./pages/Reportes/ReportesPage'));

function RouteFallback() {
  return <p className="route-fallback" role="status">Cargando…</p>;
}

function AppHeader({ isAdminMode, activeAdminMeta }) {
  const chrome = useAppChrome();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
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
    mustChangePassword,
    sidebarItems
  } = chrome;
  const { rejectedItems, isOnline } = useOfflineQueue();
  const { mode: runtimeMode } = useRuntime();
  const rejectedCount = rejectedItems.length;
  const activeTab = location.pathname.startsWith('/guardia/')
    ? tabFromGuardiaSegment(location.pathname.split('/')[2])
    : '';

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const closeMenu = () => setMenuOpen(false);

  const accountControls = (extraClass) => (
    <div className={extraClass}>
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={toggleTheme}
        aria-label={isDark ? 'Activar modo claro' : 'Activar modo oscuro'}
        title={isDark ? 'Modo claro' : 'Modo oscuro'}
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
        <span className="header-drawer-label">{isDark ? 'Modo claro' : 'Modo oscuro'}</span>
      </button>
      <button
        type="button"
        className="btn-onboarding-link"
        onClick={() => {
          setTourAuto(false);
          setTourOpen(true);
          closeMenu();
        }}
        title="Ver tutorial"
        aria-label="Ver tutorial"
      >
        <CircleHelp size={16} />
        <span className="btn-onboarding-link__label">Ver tutorial</span>
      </button>
      <span className="user-info-tag">
        {currentUser.username} · {displayRoleLabel(currentUser)}
      </span>
      <button
        type="button"
        className="btn-onboarding-link"
        onClick={() => {
          setChangePasswordOpen(true);
          closeMenu();
        }}
        title="Cambiar mi contraseña"
        aria-label="Cambiar mi contraseña"
        disabled={mustChangePassword}
      >
        <KeyRound size={16} />
        <span className="btn-onboarding-link__label">Mi contraseña</span>
      </button>
      {runtimeMode !== 'lan' && canAccessAdmin(currentUser) && (
        isAdminMode ? (
          <button
            type="button"
            className="btn-admin-panel is-active"
            onClick={() => {
              exitAdminPanel();
              closeMenu();
            }}
          >
            <ArrowLeft size={16} /> Volver a operación
          </button>
        ) : (
          <button
            type="button"
            className="btn-admin-panel"
            onClick={() => {
              enterAdminPanel();
              closeMenu();
            }}
          >
            <Settings size={16} /> Panel admin
          </button>
        )
      )}
      {canAccessGuardia(currentUser) && canAccessAdmin(currentUser) && (
        <Link to="/" className="btn-onboarding-link" title="Cambiar de área" onClick={closeMenu}>
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
  );

  return (
    <header className={`app-header app-header-modern${isAdminMode ? ' app-header--admin' : ''}`}>
      <div className="app-header-content">
        <div className="app-header-brand">
          <img src={brand.logoPath} alt={brand.logoAlt} className="auth-logo" />
          <div className="app-header-brand__text">
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
            <div className="app-header-search">
              <GlobalSearch onNavigate={navigateToTab} />
            </div>
          )}
          <RuntimeModeBadge />
          <span
            className={`conn-pill${isOnline ? ' conn-pill--on' : ' conn-pill--off'}`}
            role="status"
          >
            {isOnline ? 'En línea' : 'Sin conexión'}
          </span>
          {pendingCount > 0 && (
            <span
              className="offline-badge"
              title="Registros pendientes de envío (sin conexión)"
            >
              <CloudOff size={16} aria-hidden />
              <span className="offline-badge__count">{pendingCount}</span>
            </span>
          )}
          {rejectedCount > 0 && (
            <button
              type="button"
              className="offline-badge offline-badge--rejected"
              title="Hay registros que no se pudieron enviar"
              onClick={() => {
                closeMenu();
                document.getElementById('rejected-queue-panel')?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'start'
                });
              }}
            >
              <CloudOff size={16} aria-hidden />
              <span className="offline-badge__count">{rejectedCount}</span>
            </button>
          )}
          <button
            type="button"
            className="header-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="app-header-drawer"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
            <span>Menú</span>
          </button>
          {accountControls('app-header-actions__bar')}
        </div>
      </div>
      {menuOpen && (
        <div id="app-header-drawer" className="app-header-drawer">
          {!isAdminMode && (
            <nav aria-label="Secciones">
              <ul className="app-sidebar-list">
                {sidebarItems.map(({ id, label, icon: Icon }) => (
                  <li key={id}>
                    <button
                      type="button"
                      className={`app-sidebar-link${activeTab === id ? ' active' : ''}`}
                      onClick={() => {
                        closeMenu();
                        navigateToTab(id);
                      }}
                    >
                      <Icon size={18} aria-hidden />
                      <span>{label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {accountControls('app-header-drawer__account')}
        </div>
      )}
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
  const runtime = useRuntime();
  const { tabSegment } = useParams();
  const lanBlocked = (featureId) => runtime.status === 'ready'
    && runtime.mode === 'lan'
    && !isLanFeatureAllowed(featureId, runtime.capabilities);

  if (tabSegment === 'botonera-ventana') {
    if (lanBlocked('botonera')) {
      return (
        <ForcePasswordGate>
          <LanUnavailable title="Puertas" />
        </ForcePasswordGate>
      );
    }
    return (
      <ForcePasswordGate>
        <BotoneraPopupPage />
      </ForcePasswordGate>
    );
  }

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
    if (lanBlocked('kiosk')) {
      return (
        <ForcePasswordGate>
          <LanUnavailable title="Acceso" />
        </ForcePasswordGate>
      );
    }
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
            user={currentUser}
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
                showAdmin={false}
                items={sidebarItems}
              />
              <div className={`app-content${activeTab === 'botonera' ? ' app-content--puertas' : ''}`}>
                {activeTab !== 'inicio' && runtime.mode !== 'lan' && hasPermission(currentUser, 'fleet.gps.read') && (
                  <FleetGatePanel
                    authToken={authToken}
                    enabled
                    compact
                    pollSeconds={20}
                    onMovementRegistered={handleGpsMovementsRegistered}
                  />
                )}
                {['personal', 'vehiculo', 'flota', 'novedad'].includes(activeTab) && !lanBlocked(activeTab) && (
                  <LiveClockBar
                    activeTab={activeTab}
                    onApplyTime={(timeValue) => applyCurrentTime(timeValue, activeTab)}
                    onCopyTime={copyCurrentTime}
                  />
                )}
                <main className="app-main-inner">
                  {lanBlocked(activeTab) ? (
                    <LanUnavailable title="Esta pantalla" />
                  ) : (
                  <>
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
                  {activeTab === 'botonera' && (
                    hasPermission(currentUser, 'monitoring.doors.panel')
                    || hasPermission(currentUser, 'guard.doors.panel')
                    || hasPermission(currentUser, 'access.manual_open')
                  ) && (
                    <div className="form-section botonera-inline-fallback">
                      <div className="botonera-inline-fallback__banner">
                        <p>
                          En una computadora de escritorio, las puertas también pueden ir en una
                          <strong> ventana aparte</strong> (otro monitor).
                        </p>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => openBotoneraWindow()}
                        >
                          Abrir en otra ventana
                        </button>
                      </div>
                      <DigitalDoorPanel
                        profile={hasPermission(currentUser, 'guard.doors.panel') ? 'guardia' : 'monitoreo'}
                        canManualOpen={hasPermission(currentUser, 'access.manual_open')}
                        botoneraMode
                      />
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
                  {activeTab === 'autorizaciones' && <AutorizacionesPage />}
                  {activeTab === 'vehiculo' && <VehiculosExternosPage />}
                  {activeTab === 'flota' && <FlotaInternaPage />}
                  {activeTab === 'novedad' && <NovedadPage />}
                  {(activeTab === 'historial' || activeTab === 'allRecords') && <HistorialPage />}
                  {activeTab === 'alarmas' && (
                    (hasPermission(currentUser, 'alarmas.ver') || runtime.mode === 'lan')
                      ? <GuardAlarmsPanel />
                      : <p className="theme-section-desc">No tenés permiso para ver las alarmas.</p>
                  )}
                  {activeTab === 'reportes' && (
                    <Suspense fallback={<RouteFallback />}>
                      <ReportesPage />
                    </Suspense>
                  )}
                  </>
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
  const runtime = useRuntime();

  useEffect(() => {
    if (runtime.mode === 'lan') return;
    if (!resolvedSection) {
      navigate(adminPath(getDefaultAdminSection(currentUser)), { replace: true });
    }
  }, [resolvedSection, currentUser, navigate, runtime.mode]);

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
            user={currentUser}
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
                  {runtime.mode === 'lan' ? (
                    <LanUnavailable title="Administración" />
                  ) : resolvedSection && (
                    <Suspense fallback={<RouteFallback />}>
                      <AdminPage
                        adminSection={adminSection}
                        onSectionChange={(id) => navigate(adminPath(id))}
                        onExit={exitAdminPanel}
                        authPrefillKey={authPrefillKey}
                      />
                    </Suspense>
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
  const { currentUser } = useAuth();
  const visitas = hasPermission(currentUser, 'visitas.view.own')
    || hasPermission(currentUser, 'visitas.create')
    || hasPermission(currentUser, 'visitas.request');
  if (!visitas && hasPermission(currentUser, 'autorizaciones.solicitar')) {
    return <Navigate to="/empleado/autorizaciones" replace />;
  }
  return <Navigate to="/empleado/visitas" replace />;
}

function ModeSelectRoute() {
  const { currentUser } = useAuth();
  const runtime = useRuntime();
  const guardia = canAccessGuardia(currentUser);
  const admin = canAccessAdmin(currentUser);
  if (canAccessEmpleado(currentUser) && !guardia && !admin) {
    return <Navigate to="/empleado" replace />;
  }
  if (runtime.mode === 'lan') {
    if (guardia) return <Navigate to={guardiaPath('inicio')} replace />;
    return (
      <div className="app-shell" style={{ padding: '1rem' }}>
        <LanUnavailable title="Administración" />
      </div>
    );
  }
  if (guardia && admin) return <ModeSelectPage />;
  return <Navigate to={resolveHomePath(currentUser)} replace />;
}

function AuthenticatedShell() {
  return (
    <AppChromeProvider>
      <CriticalAlarmBanner />
      <ConnectivityChrome />
      <Outlet />
    </AppChromeProvider>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/invitacion/:token" element={<VisitaInvitacionPage />} />
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
        <Route
          path="autorizaciones"
          element={(
            <RequireEmpleado>
              <AutorizacionesPage />
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
            <RuntimeProvider>
              <HubLiveProvider>
                <GuardAlarmsProvider>
                  <OfflineQueueProvider>
                    <EntriesProvider>
                      <ClockPrefillProvider>
                        <AppRoutes />
                      </ClockPrefillProvider>
                    </EntriesProvider>
                  </OfflineQueueProvider>
                </GuardAlarmsProvider>
              </HubLiveProvider>
            </RuntimeProvider>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
