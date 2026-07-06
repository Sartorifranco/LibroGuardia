import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldX, User, LogOut } from 'lucide-react';
import ContinuousScanner from './ContinuousScanner';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

const REASON_LABELS = {
  permanent: 'Autorización permanente',
  visit: 'Visita autorizada',
  visita: 'Visita autorizada',
  temporal: 'Autorización temporal',
  citacion: 'Citación',
  manual_override: 'Autorización manual',
  persona_inactiva: 'Persona inactiva',
  no_encontrado: 'No registrado',
  sin_citacion_para_hoy: 'Sin autorización vigente',
    ingreso_excepcional: 'Ingreso excepcional',
    denied: 'Sin autorización'
};

function AccessKiosk({ authToken, currentUser, onExit, resetSeconds = 4 }) {
  const [status, setStatus] = useState('listening');
  const [result, setResult] = useState(null);
  const [processing, setProcessing] = useState(false);
  const resetTimerRef = useRef(null);

  const clearResetTimer = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  const resetToListening = useCallback(() => {
    clearResetTimer();
    setResult(null);
    setStatus('listening');
    setProcessing(false);
  }, []);

  useEffect(() => () => clearResetTimer(), []);

  const handleScan = async (rawData) => {
    if (processing || status === 'processing') return;

    setProcessing(true);
    setStatus('processing');
    setResult(null);

    try {
      const response = await fetch(`${API_BASE_URL}/access/kiosk-scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ rawData })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Error al procesar el escaneo');
      }

      setResult(data);
      setStatus(data.authorized ? 'authorized' : 'denied');

      resetTimerRef.current = setTimeout(() => {
        resetToListening();
      }, resetSeconds * 1000);
    } catch (err) {
      setResult({
        authorized: false,
        message: err.message || 'Error al validar acceso',
        name: '',
        idNumber: ''
      });
      setStatus('denied');
      resetTimerRef.current = setTimeout(() => {
        resetToListening();
      }, resetSeconds * 1000);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className={`kiosk-screen kiosk-screen-${status}`}>
      <div className="kiosk-topbar">
        <div className="kiosk-brand">
          <img src="B roja.png" alt="Bacar" className="auth-logo" />
          <div>
            <h1>Control de acceso</h1>
            <p>Escanee su DNI o QR para ingresar</p>
          </div>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onExit}>
          <LogOut size={18} /> Salir del molinete
        </button>
      </div>

      <div className="kiosk-layout">
        <div className="kiosk-scanner-panel">
          <ContinuousScanner
            onScan={handleScan}
            scannerId="kiosk-continuous-scanner"
            paused={status === 'processing'}
          />
        </div>

        <div className="kiosk-result-panel">
          {status === 'listening' && (
            <div className="kiosk-idle">
              <ScanWaitingAnimation />
              <h2>Esperando documento</h2>
              <p>Acerque el DNI o el código QR al lector</p>
            </div>
          )}

          {status === 'processing' && (
            <div className="kiosk-processing">
              <div className="kiosk-spinner" />
              <h2>Verificando autorización...</h2>
            </div>
          )}

          {status === 'authorized' && result && (
            <div className="kiosk-result kiosk-result-success">
              <ShieldCheck size={72} />
              <h2>ACCESO AUTORIZADO</h2>
              <p className="kiosk-person-name">{result.name || 'Visitante'}</p>
              <p className="kiosk-person-meta">DNI {result.idNumber}</p>
              {result.authorizationLabel && (
                <span className="kiosk-auth-badge success">{result.authorizationLabel}</span>
              )}
              {result.destination && (
                <p className="kiosk-detail">Destino: {result.destination}</p>
              )}
              {result.relayTriggered && (
                <p className="kiosk-detail">Molinete habilitado</p>
              )}
            </div>
          )}

          {status === 'denied' && result && (
            <div className="kiosk-result kiosk-result-denied">
              <ShieldX size={72} />
              <h2>ACCESO DENEGADO</h2>
              {result.name && <p className="kiosk-person-name">{result.name}</p>}
              {result.idNumber && <p className="kiosk-person-meta">DNI {result.idNumber}</p>}
              <p className="kiosk-deny-message">{result.message || 'No tiene autorización vigente'}</p>
              <span className="kiosk-auth-badge danger">
                {REASON_LABELS[result.authorizationType] || 'Sin autorización'}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="kiosk-footer">
        Operador: {currentUser?.username} · Bacar S.A.
      </div>
    </div>
  );
}

function ScanWaitingAnimation() {
  return (
    <div className="kiosk-pulse-ring">
      <User size={48} />
    </div>
  );
}

export default AccessKiosk;
