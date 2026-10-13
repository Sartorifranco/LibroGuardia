import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { Moon, Sun } from 'lucide-react';
import { apiFetch } from '../../services/api';
import brand from '../../config/brand';
import { useTheme } from '../../hooks/useTheme';
import { buildVisitaQrPayload } from '../../utils/visitaInvite';
import { formatValidezInvitacion } from '../../utils/visitaDuracion';

function VisitaInvitacionPage() {
  const { token } = useParams();
  const { toggleTheme, isDark } = useTheme();
  const [invite, setInvite] = useState(null);
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await apiFetch(`/public/visita-invite/${encodeURIComponent(token)}`, {
          token: null,
          skipSessionExpiry: true
        });
        if (cancelled) return;
        setInvite(data.invite || null);
        setGone(false);
        setError('');
      } catch (err) {
        if (!cancelled) {
          setInvite(null);
          setGone(err.status === 410);
          setError(err.message || 'No se pudo cargar la invitación');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!invite) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const payload = buildVisitaQrPayload(invite);
        if (!payload) throw new Error('Tu invitación todavía no tiene QR. Pedile a quien te invitó que te la mande de nuevo.');
        const url = await QRCode.toDataURL(payload, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: 'M'
        });
        if (!cancelled) setDataUrl(url);
      } catch (err) {
        if (!cancelled) setError(err.message || 'No se pudo generar el QR');
      }
    })();
    return () => { cancelled = true; };
  }, [invite]);

  // TODO(visitas): horario diario del pase por mes ("lun a vie 8 a 17") cuando el link público lo devuelva.
  const validez = invite ? formatValidezInvitacion(invite) : '';

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

      <div className="auth-card auth-card-modern empleado-card visita-invite-page">
        <div className="auth-brand">
          <img src={brand.logoPath} alt={brand.logoAlt} className="auth-logo" />
          <div>
            <h1 className="auth-title">Invitación de visita</h1>
            {!gone && <p className="auth-subtitle">Mostrá este QR en el acceso o usá tu DNI</p>}
          </div>
        </div>

        {loading && <p className="auth-help-text">Cargando invitación…</p>}

        {gone && !loading && (
          <div className="visita-invite-page__gone" role="alert">
            <h2>Esta invitación ya no es válida</h2>
            <p className="auth-help-text">
              Puede que haya vencido o que la hayan cancelado. Si tenés que venir igual,
              pedile una nueva a quien te invitó.
            </p>
          </div>
        )}

        {error && !gone && !loading && (
          <p className="auth-help-text" role="alert">{error}</p>
        )}

        {invite && !loading && (
          <>
            <div className="visita-invite-page__meta">
              <p><strong>{invite.nombreVisitante}</strong></p>
              {invite.dniMasked ? <p>DNI {invite.dniMasked}</p> : null}
              <p>Destino: {invite.destinoNombre || '—'}</p>
              {validez && <p className="visita-invite-page__window">{validez}</p>}
            </div>

            {dataUrl ? (
              <img src={dataUrl} alt="QR de acceso" className="visita-invite-page__qr" />
            ) : (
              !error && <p className="auth-help-text">Generando QR…</p>
            )}

            <p className="auth-help-text">
              Podés ingresar mostrando este QR en el lector o con tu DNI físico.
              El acceso solo vale dentro de la ventana indicada y por las puertas del destino.
            </p>
          </>
        )}

        <p className="auth-footer-links">
          <Link to="/empleado/login">Soy empleado — iniciar sesión</Link>
        </p>
      </div>
    </div>
  );
}

export default VisitaInvitacionPage;
