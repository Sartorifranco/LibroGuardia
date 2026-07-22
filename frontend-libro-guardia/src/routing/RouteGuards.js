import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { canAccessAdmin, canAccessEmpleado, canAccessGuardia } from '../utils/permissions';

export function AuthLoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="flex items-center space-x-2">
        <Loader2 className="animate-spin" size={24} />
        <span>Cargando aplicación...</span>
      </div>
    </div>
  );
}

/** Requiere sesión autenticada. */
export function RequireAuth({ children }) {
  const { currentUser, authLoading } = useAuth();
  const location = useLocation();

  if (authLoading) return <AuthLoadingScreen />;
  if (!currentUser) {
    const loginPath = String(location.pathname || '').startsWith('/empleado')
      ? '/empleado/login'
      : '/login';
    return <Navigate to={loginPath} replace state={{ from: location.pathname }} />;
  }
  return children;
}

const fallbackForDenied = (user) => {
  if (canAccessEmpleado(user) && !canAccessGuardia(user) && !canAccessAdmin(user)) {
    return '/empleado';
  }
  if (canAccessAdmin(user)) return '/admin';
  if (canAccessGuardia(user)) return '/guardia';
  if (canAccessEmpleado(user)) return '/empleado';
  return '/login';
};

/** Rama /guardia — mismos criterios que canAccessGuardia. */
export function RequireGuardia({ children }) {
  const { currentUser } = useAuth();
  if (!canAccessGuardia(currentUser)) {
    return <Navigate to={fallbackForDenied(currentUser)} replace />;
  }
  return children;
}

/** Rama /admin — mismos criterios que canAccessAdmin. */
export function RequireAdmin({ children }) {
  const { currentUser } = useAuth();
  if (!canAccessAdmin(currentUser)) {
    return <Navigate to={fallbackForDenied(currentUser)} replace />;
  }
  return children;
}

/** Rama /empleado — visitas propias. */
export function RequireEmpleado({ children }) {
  const { currentUser } = useAuth();
  if (!canAccessEmpleado(currentUser)) {
    return <Navigate to={fallbackForDenied(currentUser)} replace />;
  }
  return children;
}
