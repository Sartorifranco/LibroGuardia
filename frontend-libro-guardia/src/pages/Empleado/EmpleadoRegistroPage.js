import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, UserPlus, Moon, Sun } from 'lucide-react';
import ToastStack from '../../components/ToastStack';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../hooks/useTheme';
import { apiFetch } from '../../services/api';
import brand from '../../config/brand';

function EmpleadoRegistroPage() {
  const navigate = useNavigate();
  const { error, successMessage, showError, showSuccess, clearMessages, setError, setSuccessMessage } = useToast();
  const { toggleTheme, isDark } = useTheme();
  const [email, setEmail] = useState('');
  const [nombre, setNombre] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);
    try {
      await apiFetch('/auth/self-register', {
        method: 'POST',
        token: null,
        skipSessionExpiry: true,
        body: {
          email: String(email || '').trim().toLowerCase(),
          nombre: String(nombre || '').trim(),
          password
        }
      });
      showSuccess('Cuenta creada. Ya podés iniciar sesión.');
      setTimeout(() => navigate('/empleado/login', { replace: true }), 600);
    } catch (err) {
      showError(err.message || 'No se pudo completar el registro');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page empleado-auth-page">
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
      <div className="auth-card auth-card-modern empleado-card">
        <div className="auth-brand">
          <img src={brand.logoPath} alt={brand.logoAlt} className="auth-logo" />
          <div>
            <h1 className="auth-title">Registro de empleado</h1>
            <p className="auth-subtitle">Alta por dominio de email corporativo</p>
          </div>
        </div>

        <p className="auth-help-text">
          Solo dominios habilitados por administración. Después del registro iniciá sesión para cargar visitas.
        </p>

        {error && (
          <div className="error-message auth-inline-message" role="alert">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="regNombre" className="field-label">Nombre completo</label>
            <input
              id="regNombre"
              type="text"
              className="input-field"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              autoComplete="name"
              required
            />
          </div>
          <div>
            <label htmlFor="regEmail" className="field-label">Email corporativo</label>
            <input
              id="regEmail"
              type="email"
              className="input-field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              required
            />
          </div>
          <div>
            <label htmlFor="regPassword" className="field-label">Contraseña</label>
            <div className="password-field-wrap">
              <input
                id="regPassword"
                type={showPassword ? 'text' : 'password'}
                className="input-field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">Mínimo 8 caracteres; no puede ser igual al email.</p>
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={loading}>
            {loading ? 'Registrando...' : <><UserPlus size={20} /> Crear cuenta</>}
          </button>
        </form>

        <p className="auth-help-text mt-4 text-center">
          ¿Ya tenés cuenta?{' '}
          <Link to="/empleado/login" className="text-red-600 underline">Iniciar sesión</Link>
        </p>
      </div>
    </div>
  );
}

export default EmpleadoRegistroPage;
