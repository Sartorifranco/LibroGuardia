import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Copy, Mail, MessageCircle, X } from 'lucide-react';
import { buildVisitaQrPayload, getVisitaWindow } from '../utils/visitaInvite';
import { apiFetch } from '../services/api';

function buildInviteUrl(token) {
  if (!token || typeof window === 'undefined') return '';
  return `${window.location.origin}/invitacion/${encodeURIComponent(token)}`;
}

function buildShareMessage(visita, inviteUrl, windowLabel) {
  const nombre = visita?.nombreVisitante || 'visitante';
  const destino = visita?.destinoNombre || 'el predio';
  const dni = visita?.dniVisitanteNormalized || visita?.dniVisitante || '';
  return [
    `Hola ${nombre},`,
    `Tenés una visita autorizada a ${destino}.`,
    windowLabel || '',
    '',
    `Abrí tu invitación (QR): ${inviteUrl}`,
    '',
    `También podés ingresar mostrando tu DNI físico${dni ? ` (${dni})` : ''} en el lector.`,
    'No hace falta otra autorización: con la visita cargada ya podés pasar en la ventana indicada.'
  ].filter(Boolean).join('\n');
}

function VisitaInviteQrModal({ visita, authToken, onClose, onReady }) {
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');
  const [inviteToken, setInviteToken] = useState(visita?.inviteToken || '');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visita) return undefined;
    let cancelled = false;

    (async () => {
      try {
        let token = visita.inviteToken || '';
        if (!token && authToken && visita.id) {
          setBusy(true);
          const data = await apiFetch(`/empleado/visitas/${visita.id}/ensure-invite`, {
            method: 'POST',
            token: authToken
          });
          token = data.inviteToken || data.visita?.inviteToken || '';
          if (!cancelled) {
            setInviteToken(token);
            onReady?.(data.visita || { ...visita, inviteToken: token });
          }
        } else if (!cancelled) {
          setInviteToken(token);
        }

        const url = await QRCode.toDataURL(buildVisitaQrPayload(visita), {
          width: 280,
          margin: 2,
          errorCorrectionLevel: 'M'
        });
        if (!cancelled) {
          setDataUrl(url);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'No se pudo preparar la invitación');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => { cancelled = true; };
    // onReady es opcional; no incluirlo para evitar loops al actualizar el padre
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visita?.id, visita?.inviteToken, visita?.dniVisitante, visita?.nombreVisitante, authToken]);

  const windowInfo = useMemo(
    () => getVisitaWindow(visita?.fechaHoraEsperada),
    [visita?.fechaHoraEsperada]
  );

  const inviteUrl = buildInviteUrl(inviteToken);
  const shareMessage = buildShareMessage(visita, inviteUrl, windowInfo.label);

  const openWhatsApp = () => {
    if (!inviteUrl) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(shareMessage)}`, '_blank', 'noopener,noreferrer');
  };

  const openEmail = () => {
    if (!inviteUrl) return;
    const subject = `Invitación de visita — ${visita?.destinoNombre || 'acceso'}`;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(shareMessage)}`;
  };

  const copyLink = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(shareMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar. Copiá el link manualmente.');
    }
  };

  if (!visita) return null;

  return createPortal(
    <div className="empleado-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="empleado-modal visita-qr-modal"
        role="dialog"
        aria-modal="true"
        aria-label="QR de invitación"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="visita-qr-modal__head">
          <div>
            <h3 className="empleado-modal-title">Invitación lista</h3>
            <p className="visita-qr-modal__sub">
              {visita.nombreVisitante}
              {' · DNI '}
              {visita.dniVisitanteNormalized || visita.dniVisitante}
            </p>
          </div>
          <button type="button" className="empleado-modal-close" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        </header>

        <div className="visita-qr-modal__body">
          {error ? (
            <p className="empleado-hint">{error}</p>
          ) : dataUrl ? (
            <img src={dataUrl} alt="Código QR de invitación" className="visita-qr-modal__img" />
          ) : (
            <p className="empleado-hint">{busy ? 'Preparando invitación…' : 'Generando QR…'}</p>
          )}
          <p className="visita-qr-modal__window">{windowInfo.label}</p>
          <p className="visita-qr-modal__help">
            Ya está autorizada al cargarla vos. No hace falta que un guardia la apruebe antes.
            El visitante puede usar este QR o su DNI físico en el lector, dentro de la ventana y
            puertas del destino
            {' '}
            <strong>{visita.destinoNombre || 'seleccionado'}</strong>
            .
          </p>
          {inviteUrl ? (
            <p className="visita-qr-modal__link">
              <a href={inviteUrl} target="_blank" rel="noreferrer">{inviteUrl}</a>
            </p>
          ) : null}
        </div>

        <div className="visita-qr-modal__share">
          <button type="button" className="btn btn-primary" onClick={openWhatsApp} disabled={!inviteUrl}>
            <MessageCircle size={16} />
            WhatsApp
          </button>
          <button type="button" className="btn btn-secondary" onClick={openEmail} disabled={!inviteUrl}>
            <Mail size={16} />
            Mail
          </button>
          <button type="button" className="btn btn-secondary" onClick={copyLink} disabled={!inviteUrl}>
            <Copy size={16} />
            {copied ? 'Copiado' : 'Copiar texto'}
          </button>
        </div>

        <div className="visita-qr-modal__footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default VisitaInviteQrModal;
