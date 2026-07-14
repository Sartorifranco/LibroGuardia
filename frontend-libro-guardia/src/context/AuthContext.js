import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { apiFetch } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children, onSessionInvalid }) {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('authToken') || null);
  const [currentUser, setCurrentUser] = useState(null);
  const [systemRoles, setSystemRoles] = useState([]);
  const [authLoading, setAuthLoading] = useState(true);

  const logout = useCallback((options = {}) => {
    const { clearStorage = true } = options;
    setAuthToken(null);
    if (clearStorage) localStorage.removeItem('authToken');
    setCurrentUser(null);
    setSystemRoles([]);
    onSessionInvalid?.();
  }, [onSessionInvalid]);

  const login = useCallback(async (username, password) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: {
        username: String(username || '').trim().toLowerCase(),
        password
      }
    });
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
        if (!cancelled) {
          logout();
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
        const data = await apiFetch('/admin/roles', { token: authToken });
        if (!cancelled) setSystemRoles(data.roles || []);
      } catch {
        // Sin permiso roles.view es normal en algunos perfiles
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
