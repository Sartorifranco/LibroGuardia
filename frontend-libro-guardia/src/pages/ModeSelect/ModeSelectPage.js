import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Settings, Shield } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { canAccessAdmin, canAccessGuardia } from '../../utils/permissions';
import brand from '../../config/brand';

/**
 * Pantalla de elección cuando el usuario tiene ambos árboles (guardia + admin).
 */
function ModeSelectPage() {
  const { currentUser, logout } = useAuth();
  const guardia = canAccessGuardia(currentUser);
  const admin = canAccessAdmin(currentUser);

  if (guardia && !admin) return <Navigate to="/guardia" replace />;
  if (admin && !guardia) return <Navigate to="/admin" replace />;
  if (!guardia && !admin) return <Navigate to="/login" replace />;

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-modern" style={{ maxWidth: 520 }}>
        <div className="auth-brand">
          <img src={brand.logoPath} alt={brand.logoAlt} className="auth-logo" />
          <div>
            <h1 className="auth-title" style={{ fontSize: '1.35rem' }}>{brand.appTitle}</h1>
            <p className="auth-subtitle">
              Hola {currentUser?.username}. Elegí el área con la que vas a trabajar.
            </p>
          </div>
        </div>

        <div className="space-y-3" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Link to="/guardia" className="btn-admin-panel" style={{ justifyContent: 'flex-start', textDecoration: 'none' }}>
            <Shield size={18} />
            Operación de guardia
          </Link>
          <Link to="/admin" className="btn-admin-panel" style={{ justifyContent: 'flex-start', textDecoration: 'none' }}>
            <Settings size={18} />
            Administración
          </Link>
        </div>

        <button type="button" className="btn-logout-link" style={{ marginTop: '1.25rem' }} onClick={logout}>
          Salir
        </button>
      </div>
    </div>
  );
}

export default ModeSelectPage;
