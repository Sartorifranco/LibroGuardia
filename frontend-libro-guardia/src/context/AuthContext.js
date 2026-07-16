import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import {
  apiFetch,
  resetSessionExpiryFlag,
  setSessionExpiredHandler
} from '../services/api';
import { useToast } from './ToastContext';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const { showError } = useToast();
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('authToken') || null);
  const [currentUser, setCurrentUser] = useState(null);
  const [systemRoles, setSystemRoles] = useState([]);
  const [authLoading, setAuthLoading] = useState(true);

  const logout = useCallback(() => {
    setAuthToken(null);
    try {
      localStorage.removeItem('authToken');
    } catch {
      // ignore
    }
    setCurrentUser(null);
    setSystemRoles([]);
  }, []);

  useEffect(() => {
    setSessionExpiredHandler((message) => {
      logout();
      if (message) showError(message);
    });
    return () => setSessionExpiredHandler(null);
  }, [logout, showError]);

  const login = useCallback(async (username, password) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      token: null,
      skipSessionExpiry: true,
      body: {
        username: String(username || '').trim().toLowerCase(),
        password
      }
    });
    resetSessionExpiryFlag();
    setAuthToken(data.token);
    localStorage.setItem('authToken', data.token);
    setCurrentUser(data.user);
    return data.user;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchCurrentUser = async () => {
      if (!authToken) {
        if (!cancelled) {
          setCurrentUser(null);
          setAuthLoading(false);
        }
        return;
      }

      try {
        if (!cancelled) setAuthLoading(true);
        const data = await apiFetch('/auth/me', { token: authToken });
        if (cancelled) return;
        setCurrentUser(data.user);
      } catch (err) {
        console.error('Error al obtener usuario actual:', err);
        // 401/403: apiFetch ya disparó session-expired / logout.
        // Errores de red o HTML cacheado de Hosting NO deben tumbar una sesión
        // recién creada por /auth/login (el user ya viene en esa respuesta).
        if (!cancelled && !err.isSessionExpired) {
          const keepSession = Boolean(err.isNetworkError || err.isHtmlInsteadOfApi || err.status === 0 || err.status === 502);
          if (!keepSession) {
            logout();
          }
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };

    fetchCurrentUser();
    return () => {
      cancelled = true;
    };
  }, [authToken, logout]);

  useEffect(() => {
    if (!authToken || !currentUser) {
      setSystemRoles([]);
      return undefined;
    }

    let cancelled = false;
    const loadRoles = async () => {
      try {
        const data = await apiFetch('/admin/roles', {
          token: authToken,
          allowForbidden: true
        });
        if (!cancelled) setSystemRoles(data.roles || []);
      } catch {
        if (!cancelled) setSystemRoles([]);
      }
    };
    loadRoles();
    return () => {
      cancelled = true;
    };
  }, [authToken, currentUser]);

  const value = useMemo(() => ({
    authToken,
    currentUser,
    setCurrentUser,
    systemRoles,
    setSystemRoles,
    authLoading,
    login,
    logout,
    isAuthenticated: Boolean(currentUser && authToken)
  }), [
    authToken,
    currentUser,
    systemRoles,
    authLoading,
    login,
    logout
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth debe usarse dentro de AuthProvider');
  }
  return ctx;
}

export default AuthContext;
