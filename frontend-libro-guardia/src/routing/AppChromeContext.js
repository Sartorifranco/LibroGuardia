import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useEntries } from '../context/EntriesContext';
import { useOfflineQueue } from '../context/OfflineQueueContext';
import { useClockPrefill } from '../context/ClockPrefillContext';
import { useTheme } from '../hooks/useTheme';
import { buildSidebarItems, guardiaPath, adminPath, getDefaultAdminSection } from '../utils/navigation';
import { saveAuthManualPrefill } from '../utils/authPrefill';
import { isOnboardingDone } from '../components/OnboardingTour';

const AppChromeContext = createContext(null);

export function AppChromeProvider({ children }) {
  const { authToken, currentUser, logout, changePassword } = useAuth();
  const { error, successMessage, showSuccess, showError, setError, setSuccessMessage } = useToast();
  const { reloadEntries } = useEntries();
  const { pendingCount } = useOfflineQueue();
  const { setClockPrefill } = useClockPrefill();
  const { toggleTheme, isDark } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [authPrefillKey, setAuthPrefillKey] = useState(0);
  const [personalPrefillKey, setPersonalPrefillKey] = useState(0);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourAuto, setTourAuto] = useState(false);
  const [lastGuardiaPath, setLastGuardiaPath] = useState(guardiaPath('inicio'));

  useEffect(() => {
    if (location.pathname.startsWith('/guardia/') && !location.pathname.endsWith('/kiosk')) {
      setLastGuardiaPath(location.pathname);
    }
  }, [location.pathname]);

  const handleLogout = useCallback(() => {
    logout();
    navigate('/login', { replace: true });
    setChangePasswordOpen(false);
  }, [logout, navigate]);

  const handleChangePassword = useCallback(async (currentPassword, newPassword) => {
    await changePassword(currentPassword, newPassword);
    setChangePasswordOpen(false);
    showSuccess('Contraseña actualizada');
  }, [changePassword, showSuccess]);

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

  const enterAdminPanel = useCallback(() => {
    navigate(adminPath(getDefaultAdminSection(currentUser)));
  }, [navigate, currentUser]);

  const exitAdminPanel = useCallback(() => {
    navigate(lastGuardiaPath || guardiaPath('inicio'));
  }, [navigate, lastGuardiaPath]);

  const handleAuthorizeFromScan = useCallback((prefill) => {
    saveAuthManualPrefill(prefill);
    if (prefill?.exceptional) {
      setPersonalPrefillKey((key) => key + 1);
      navigate(guardiaPath('personal'));
      showSuccess('Completá el ingreso excepcional con el DNI escaneado.');
      return;
    }
    setAuthPrefillKey((key) => key + 1);
    navigate(adminPath('citaciones'));
    showSuccess('Completá la autorización manual con los datos del escaneo.');
  }, [navigate, showSuccess]);

  const navigateToTab = useCallback((tab, timeValue) => {
    if (tab === 'adminPanel') {
      enterAdminPanel();
      return;
    }
    navigate(guardiaPath(tab));
    if (timeValue) {
      setClockPrefill(tab, timeValue);
    }
  }, [navigate, setClockPrefill, enterAdminPanel]);

  const applyCurrentTime = useCallback((timeValue, activeTab) => {
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
  }, [setClockPrefill, showSuccess]);

  const copyCurrentTime = useCallback(async (timeValue, dateLabel) => {
    try {
      await navigator.clipboard.writeText(`${timeValue} — ${dateLabel}`);
      showSuccess(`Hora copiada: ${timeValue}`);
    } catch {
      showError('No se pudo copiar la hora al portapapeles.');
    }
  }, [showSuccess, showError]);

  useEffect(() => {
    if (!currentUser) return undefined;
    if (isOnboardingDone()) return undefined;
    if (location.pathname === '/' || location.pathname.startsWith('/login')) return undefined;
    setTourAuto(true);
    setTourOpen(true);
    return undefined;
  }, [currentUser, location.pathname]);

  const value = useMemo(() => ({
    authToken,
    currentUser,
    error,
    successMessage,
    showSuccess,
    showError,
    setError,
    setSuccessMessage,
    pendingCount,
    reloadEntries,
    toggleTheme,
    isDark,
    changePasswordOpen,
    setChangePasswordOpen,
    authPrefillKey,
    personalPrefillKey,
    tourOpen,
    setTourOpen,
    tourAuto,
    setTourAuto,
    handleLogout,
    handleChangePassword,
    handleAttendanceRegistered,
    handleGpsMovementsRegistered,
    sidebarItems,
    enterAdminPanel,
    exitAdminPanel,
    handleAuthorizeFromScan,
    navigateToTab,
    applyCurrentTime,
    copyCurrentTime,
    mustChangePassword: currentUser?.mustChangePassword === true
  }), [
    authToken,
    currentUser,
    error,
    successMessage,
    showSuccess,
    showError,
    setError,
    setSuccessMessage,
    pendingCount,
    reloadEntries,
    toggleTheme,
    isDark,
    changePasswordOpen,
    authPrefillKey,
    personalPrefillKey,
    tourOpen,
    tourAuto,
    handleLogout,
    handleChangePassword,
    handleAttendanceRegistered,
    handleGpsMovementsRegistered,
    sidebarItems,
    enterAdminPanel,
    exitAdminPanel,
    handleAuthorizeFromScan,
    navigateToTab,
    applyCurrentTime,
    copyCurrentTime
  ]);

  return (
    <AppChromeContext.Provider value={value}>
      {children}
    </AppChromeContext.Provider>
  );
}

export function useAppChrome() {
  const ctx = useContext(AppChromeContext);
  if (!ctx) {
    throw new Error('useAppChrome debe usarse dentro de AppChromeProvider');
  }
  return ctx;
}
