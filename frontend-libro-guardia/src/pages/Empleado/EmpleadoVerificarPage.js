import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Moon, Sun, XCircle } from 'lucide-react';
import { apiFetch } from '../../services/api';
import brand from '../../config/brand';
import { useTheme } from '../../hooks/useTheme';

/** Link del mail de confirmación del autorregistro (sin login). */
function EmpleadoVerificarPage() {
  const { token } = useParams();
  const { toggleTheme, isDark } = useTheme();
  const [state, setState] = useState({ status: 'loading', message: '' });
  // El token se usa una sola vez: no repetir el pedido si el efecto corre dos veces.
  const requestRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!requestRef.current || requestRef.current.token !== token) {
      requestRef.current = {
        token,
        promise: apiFetch('/public/empleado/verificar', {
          method: 'POST',
          token: null,
          skipSessionExpiry: true,
          body: { token }
        })
      };
    }
    requestRef.current.promise
      .then(() => {
        if (!cancelled) setState({ status: 'ok', message: '' });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 400 || err.status === 410) {
          setState({ status: 'invalid', message: '' });
        } else {
          setState({ status: 'error', message: err.message || 'No se pudo confirmar el mail. Probá de nuevo en un rato.' });
        }
      });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="auth-page empleado-auth-page">
      <button
        type="button"
        className="theme-toggle-btn auth-theme-toggle"
        onClick={toggleTheme}
        aria-label={isDark ? 'Activar modo claro' : 'Activar modo oscuro'}
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="auth-card auth-card-modern empleado-card">
        <div className="auth-brand">
          <img src={brand.logoPath} alt={brand.logoAlt} className="auth-logo" />
          <div>
            <h1 className="auth-title">Confirmar mail</h1>
          </div>
        </div>

        {state.status === 'loading' && <p className="auth-help-text">Confirmando tu mail…</p>}

        {state.status === 'ok' && (
          <div role="status">
            <h2 className="auth-subtitle"><CheckCircle2 size={20} /> ¡Listo! Tu mail quedó confirmado</h2>
            <p className="auth-help-text">Ya podés iniciar sesión e invitar visitas.</p>
            <Link to="/empleado/login" className="btn btn-primary w-full">Iniciar sesión</Link>
          </div>
        )}

        {state.status === 'invalid' && (
          <div role="alert">
            <h2 className="auth-subtitle"><XCircle size={20} /> El link venció o ya se usó</h2>
            <p className="auth-help-text">
              Iniciá sesión y tocá <strong>Reenviar mail</strong> en Mis visitas para recibir uno nuevo.
              Si ya lo confirmaste antes, no tenés que hacer nada más.
            </p>
            <Link to="/empleado/login" className="btn btn-secondary w-full">Iniciar sesión</Link>
          </div>
        )}

        {state.status === 'error' && (
          <div role="alert">
            <p className="auth-help-text">{state.message}</p>
            <Link to="/empleado/login" className="btn btn-secondary w-full">Iniciar sesión</Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default EmpleadoVerificarPage;
