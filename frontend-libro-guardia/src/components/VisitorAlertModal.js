import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Modal } from './admin-ui/Modal';
import { useHubLive } from '../context/HubLiveContext';
import apiFetch from '../services/api';

const MAX_ALERTS = 10;
/** Evento de ventana con el aviso que llega por la nube (lo dispara LiveAlertsToaster). */
export const VISITOR_WINDOW_EVENT = 'mss:visitor';

// Helper para formatear la hora
const formatTime = (isoString) => {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' });
  } catch (error) {
    console.error('Error formateando la hora:', error);
    return '';
  }
};

// Contexto de audio para el sonido de atención
let audioCtx;
function playAttentionSound() {
  try {
    if (typeof window.AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined') {
      console.warn('AudioContext no disponible en este navegador.');
      return;
    }
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!audioCtx) {
      console.warn('No se pudo inicializar AudioContext.');
      return;
    }

    const playBeep = (delay) => {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, audioCtx.currentTime + delay); // 880 Hz
      gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime + delay); // Ganancia 0.2

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.start(audioCtx.currentTime + delay);
      oscillator.stop(audioCtx.currentTime + delay + 0.150); // Beep de 150ms
    };

    playBeep(0);
    playBeep(0.2); // Segundo beep 200ms después del primero

  } catch (e) {
    console.warn('Error al reproducir el sonido de atención:', e);
  }
}

/** Hora y texto para precargar la Novedad cuando el guardia marca "No coincide". */
export function buildMismatchNovedad(alert) {
  if (!alert) return { time: '', description: '' };
  const time = formatTime(alert.at);
  const parts = [`Nombre: ${alert.name || 'sin nombre'}`];
  if (alert.idNumber) parts.push(`documento ${alert.idNumber}`);
  if (alert.hostName || alert.hostCompany) {
    parts.push(`visita a ${[alert.hostName, alert.hostCompany && `(${alert.hostCompany})`].filter(Boolean).join(' ')}`);
  }
  if (alert.doorName) parts.push(`puerta ${alert.doorName}`);
  if (time) parts.push(`hora ${time}`);
  return {
    time,
    description: `La persona que pasó no coincide con el pase. ${parts.join(', ')}.`
  };
}

export function VisitorAlertModal({ authToken, onMismatch }) {
  const { subscribe } = useHubLive();
  const [alerts, setAlerts] = useState([]);
  const [isSendingApproval, setIsSendingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState(null);

  const currentAlert = useMemo(() => alerts.length > 0 ? alerts[0] : null, [alerts]);

  // Suena una vez por aviso nuevo (fuera del setState para no repetir en StrictMode).
  const lastIdRef = useRef(null);
  const newestId = alerts.length ? alerts[alerts.length - 1].id : null;
  useEffect(() => {
    if (newestId && newestId !== lastIdRef.current) playAttentionSound();
    lastIdRef.current = newestId;
  }, [newestId]);

  const removeCurrentAlert = useCallback(() => {
    setAlerts((prevAlerts) => prevAlerts.slice(1));
    setApprovalError(null); // Limpiar el error cuando se descarta una alerta
  }, []);

  const pushAlert = useCallback((data) => {
    if (!data || !data.id) return;
    setAlerts((prevAlerts) => {
      if (prevAlerts.some((alert) => alert.id === data.id)) return prevAlerts;
      const next = [...prevAlerts, data];
      return next.length > MAX_ALERTS ? next.slice(next.length - MAX_ALERTS) : next;
    });
  }, []);

  // Modo nube: LiveAlertsToaster reenvía las alertas 'visitor_pass' como evento de ventana.
  // Mismo id que el SSE del hub, así no se repite el cartel si llegan por los dos caminos.
  useEffect(() => {
    const onWindowVisitor = (event) => pushAlert(event.detail);
    window.addEventListener(VISITOR_WINDOW_EVENT, onWindowVisitor);
    return () => window.removeEventListener(VISITOR_WINDOW_EVENT, onWindowVisitor);
  }, [pushAlert]);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.type !== 'visitor' || !event.data) return;

      setAlerts((prevAlerts) => {
        // No agregar si el ID ya existe en la cola
        if (prevAlerts.some(alert => alert.id === event.data.id)) {
          return prevAlerts;
        }

        const newAlerts = [...prevAlerts, event.data];
        // Mantener un máximo de 10 avisos
        if (newAlerts.length > MAX_ALERTS) {
          newAlerts.shift(); // Eliminar el más viejo
        }
        return newAlerts;
      });
    });
    return unsubscribe;
  }, [subscribe]);


  const handleApprove = useCallback(async (approve) => {
    if (!currentAlert || currentAlert.kind !== 'aprobacion' || !currentAlert.approvalId) return;

    setIsSendingApproval(true);
    setApprovalError(null);
    try {
      await apiFetch(`/guard/approvals/${encodeURIComponent(currentAlert.approvalId)}`, {
        method: 'POST',
        token: authToken,
        body: { approve }
      });
      removeCurrentAlert();
    } catch (err) {
      setApprovalError(err.message || "No se pudo enviar. Probá de nuevo.");
    } finally {
      setIsSendingApproval(false);
    }
  }, [currentAlert, authToken, removeCurrentAlert]);

  const handleCloseModal = useCallback(() => {
    if (!currentAlert) return;

    if (currentAlert.kind === 'aprobacion') {
      // Para aprobación, solo cerrar el modal sin tomar acción sobre la aprobación
      removeCurrentAlert();
    } else {
      // Para visita/externo, cerrar el modal actúa como "Es la persona"
      removeCurrentAlert();
    }
  }, [currentAlert, removeCurrentAlert]);


  if (!currentAlert) {
    return null;
  }

  let title = '';
  let helpText = '';
  let footerButtons = null;

  switch (currentAlert.kind) {
    case 'visita':
      title = "Pasó una visita";
      helpText = "Mirá a la persona y confirmá que es quien dice el cartel.";
      footerButtons = (
        <>
          <button type="button" className="btn btn-danger" onClick={() => {
            if (onMismatch) onMismatch(currentAlert);
            removeCurrentAlert();
          }} data-aui-cancel="true">
            No coincide
          </button>
          <button type="button" className="btn btn-primary" onClick={removeCurrentAlert}>
            Es la persona
          </button>
        </>
      );
      break;
    case 'externo':
      title = "Pasó una persona externa";
      helpText = "Mirá a la persona y confirmá que es quien dice el cartel.";
      footerButtons = (
        <>
          <button type="button" className="btn btn-danger" onClick={() => {
            if (onMismatch) onMismatch(currentAlert);
            removeCurrentAlert();
          }} data-aui-cancel="true">
            No coincide
          </button>
          <button type="button" className="btn btn-primary" onClick={removeCurrentAlert}>
            Es la persona
          </button>
        </>
      );
      break;
    case 'aprobacion':
      title = "Alguien pide entrar";
      helpText = "Esta puerta necesita tu OK. Mirá a la persona antes de abrir.";
      footerButtons = (
        <>
          <button type="button" className="btn btn-danger" onClick={() => handleApprove(false)} disabled={isSendingApproval}>
            No abrir
          </button>
          <button type="button" className="btn btn-primary" onClick={() => handleApprove(true)} disabled={isSendingApproval}>
            Abrir
          </button>
        </>
      );
      break;
    default:
      title = "Nuevo aviso"; // Fallback genérico
      helpText = "";
  }

  const doorDirection = currentAlert.side === 'out' ? ' · salida' : (currentAlert.side === 'in' ? ' · entrada' : '');
  const doorInfo = currentAlert.doorName ? `${currentAlert.doorName}${doorDirection}` : null;


  return (
    <Modal
      open={Boolean(currentAlert)}
      title={title}
      onClose={handleCloseModal}
      size="sm"
      footer={footerButtons}
    >
      {alerts.length > 1 && (
        <p className="aui-modal__sub-title">{alerts.length === 2 ? 'Hay 1 aviso más' : `Hay ${alerts.length - 1} avisos más`}</p>
      )}
      <dl className="aui-modal__details-list">
        <dt>Nombre</dt>
        <dd>{currentAlert.name || 'Sin nombre'}</dd>
        {currentAlert.idNumber && (
          <>
            <dt>Documento</dt>
            <dd>{currentAlert.idNumber}</dd>
          </>
        )}
        {(currentAlert.hostName || currentAlert.hostCompany) ? (
          <>
            <dt>Visita a</dt>
            <dd>
              {currentAlert.hostName}
              {currentAlert.hostCompany && ` (${currentAlert.hostCompany})`}
            </dd>
          </>
        ) : null}
        {currentAlert.destination && (
          <>
            <dt>Destino</dt>
            <dd>{currentAlert.destination}</dd>
          </>
        )}
        {doorInfo && (
          <>
            <dt>Puerta</dt>
            <dd>{doorInfo}</dd>
          </>
        )}
        {currentAlert.at && (
          <>
            <dt>Hora</dt>
            <dd>{formatTime(currentAlert.at)}</dd>
          </>
        )}
      </dl>
      <p className="aui-modal__help-text">{helpText}</p>
      {approvalError && (
        <p role="alert" className="aui-modal__error-message">{approvalError}</p>
      )}
    </Modal>
  );
}

export default VisitorAlertModal;
