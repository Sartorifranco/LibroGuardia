import React from 'react';
import { ExternalLink, LogOut, Moon, Sun } from 'lucide-react';
import DigitalDoorPanel from '../../components/DigitalDoorPanel';
import LiveAlertsToaster from '../../components/LiveAlertsToaster';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../hooks/useTheme';
import { hasPermission } from '../../utils/permissions';
import brand from '../../config/brand';

/**
 * Ventana dedicada a la botonera (segundo monitor).
 * Sin sidebar: puertas + alertas de verificación de identidad.
 */
function BotoneraPopupPage() {
  const { currentUser, logout } = useAuth();
  const { toggleTheme, isDark } = useTheme();
  const canOpen = hasPermission(currentUser, 'monitoring.doors.panel')
    || hasPermission(currentUser, 'guard.doors.panel')
    || hasPermission(currentUser, 'access.manual_open');

  return (
    <div className="botonera-popup-page">
      <LiveAlertsToaster pollMs={4000} />
      <header className="botonera-popup-header">
        <div className="botonera-popup-brand">
          <img src={brand.logoPath} alt="" className="botonera-popup-logo" />
          <div>
            <strong>{brand.appTitle}</strong>
            <span>Botonera · ventana dedicada</span>
          </div>
        </div>
        <div className="botonera-popup-actions">
          <button
            type="button"
            className="btn btn-secondary-small"
            onClick={toggleTheme}
            title={isDark ? 'Modo claro' : 'Modo oscuro'}
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            type="button"
            className="btn btn-secondary-small"
            onClick={() => {
              try {
                window.open(`${window.location.origin}/guardia/inicio`, '_blank', 'noopener');
              } catch { /* ignore */ }
            }}
            title="Abrir sistema completo"
          >
            <ExternalLink size={16} />
            Sistema
          </button>
          <button
            type="button"
            className="btn-logout-link"
            onClick={() => {
              logout();
              window.close();
            }}
          >
            <LogOut size={16} />
            Salir
          </button>
        </div>
      </header>
      <main className="botonera-popup-main">
        {canOpen ? (
          <DigitalDoorPanel
            profile={hasPermission(currentUser, 'guard.doors.panel') ? 'guardia' : 'monitoreo'}
            canManualOpen={hasPermission(currentUser, 'access.manual_open')}
            botoneraMode
            standaloneWindow
          />
        ) : (
          <p className="control-doors__hint">Sin permiso de apertura manual.</p>
        )}
      </main>
    </div>
  );
}

export default BotoneraPopupPage;
