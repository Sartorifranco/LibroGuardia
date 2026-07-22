import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, LogIn, Moon, Save, Sun } from 'lucide-react';
import ToastStack from '../../components/ToastStack';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../hooks/useTheme';
import brand from '../../config/brand';

/**
 * Login unificado (mismo /api/auth/login).
 * variant="empleado" solo ajusta copy y enlace a autoregistro.
 */
function LoginPage({ variant = 'default' } = {}) {
  const { login } = useAuth();
  const { error, successMessage, showError, clearMessages, setError, setSuccessMessage } = useToast();
  const { toggleTheme, isDark } = useTheme();
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const isEmpleado = variant === 'empleado';

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      await login(loginUsername, loginPassword);
      clearMessages();
    } catch (err) {
      console.error('Error de autenticación:', err);
      showError(err.message || 'Error de autenticación. Intente de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`auth-page${isEmpleado ? ' empleado-auth-page' : ''}`}>
      <button
        type="button"
        className="theme-toggle-btn auth-theme-toggle"
        onClick={toggleTheme}
        aria-label={isDark ? 'Activar modo claro' : 'Activar modo oscuro'}
        title={isDark ? 'Modo claro' : 'Modo oscuro'}
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <ToastStack
        error={error}
        successMessage={successMessage}
        onDismissError={() => setError(null)}
        onDismissSuccess={() => setSuccessMessage(null)}
      />
      <div className="auth-card auth-card-modern">
        <div className="auth-brand">
          <img src={brand.logoPath} alt={brand.logoAlt} className="auth-logo" />
          <div>
            <h1 className="auth-title">
              {isEmpleado ? 'Acceso empleado' : brand.loginTitle}
            </h1>
            <p className="auth-subtitle">
              {isEmpleado ? 'Carga de visitas de invitados' : brand.loginSubtitle}
            </p>
          </div>
        </div>

        <p className="auth-help-text">
          {isEmpleado ? (
            <>
              Usá el email con el que te registraste.{' '}
              <Link to="/empleado/registro" className="text-red-600 underline">
                Crear cuenta
              </Link>
            </>
          ) : (
            'El acceso es provisto por un administrador. Si no tiene usuario, contacte a Sistemas o a su supervisor.'
          )}
        </p>

        {error && (
          <div className="error-message auth-inline-message" role="alert">
            <AlertCircle size={20} />
            <span className="block sm:inline">{error}</span>
          </div>
        )}
        {successMessage && (
          <div className="success-message auth-inline-message" role="status">
            <Save size={20} />
            <span className="block sm:inline">{successMessage}</span>
          </div>
        )}

        <form onSubmit={handleAuthSubmit} className="space-y-4">
          <div>
            <label htmlFor="authUsername" className="field-label">
              {isEmpleado ? 'Email' : 'Usuario'}
            </label>
            <input
              type="text"
              id="authUsername"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              className="input-field"
              placeholder={isEmpleado ? 'usuario@empresa.com' : brand.loginUsernamePlaceholder}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </div>
          <div>
            <label htmlFor="authPassword" className="field-label">Contraseña</label>
            <div className="password-field-wrap">
              <input
                type={showLoginPassword ? 'text' : 'password'}
                id="authPassword"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="input-field"
                placeholder="Ingrese su contraseña"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowLoginPassword(!showLoginPassword)}
                aria-label={showLoginPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showLoginPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={loading}
          >
            {loading ? 'Cargando...' : <><LogIn size={20} /> Entrar al sistema</>}
          </button>
        </form>
      </div>
    </div>
  );
}

export default LoginPage;
