import React, { useCallback, useEffect, useRef, useState } from 'react';

import { ShieldCheck, ShieldX, User, LogOut, AlertTriangle } from 'lucide-react';

import ContinuousScanner from './ContinuousScanner';
import ManualDoorButton from './ManualDoorButton';
import { apiFetch } from '../services/api';

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

  denied: 'Sin autorización',

  sin_citacion_hoy: 'Sin citación hoy',

  fuera_dia_turno: 'Fuera de día de turno',

  fuera_horario_turno: 'Fuera de horario',

  sistemas_acceso_permanente: 'Sistemas — acceso permanente'

};



function AccessKiosk({

  authToken,

  currentUser,

  onExit,

  resetSeconds = 4,

  canExceptionalEntry = false,

  doorId = null,

  readerId = 'default'

}) {

  const [status, setStatus] = useState('listening');

  const [result, setResult] = useState(null);

  const [processing, setProcessing] = useState(false);

  const [exceptionalReason, setExceptionalReason] = useState('');

  const [showExceptionalForm, setShowExceptionalForm] = useState(false);

  const [doorFeedback, setDoorFeedback] = useState('');

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

    setExceptionalReason('');

    setShowExceptionalForm(false);

  }, []);



  useEffect(() => () => clearResetTimer(), []);



  const scheduleReset = useCallback((seconds, denied = false) => {

    clearResetTimer();

    const delay = denied && canExceptionalEntry ? Math.max(seconds, 45) : seconds;

    resetTimerRef.current = setTimeout(() => {

      resetToListening();

    }, delay * 1000);

  }, [canExceptionalEntry, resetToListening]);



  const handleScan = async (rawData) => {

    if (processing || status === 'processing') return;



    setProcessing(true);

    setStatus('processing');

    setResult(null);

    setShowExceptionalForm(false);

    setExceptionalReason('');



    try {

      const data = await apiFetch('/access/kiosk-scan', {
        method: 'POST',
        token: authToken,
        body: { rawData, doorId, readerId }
      });



      setResult(data);

      if (data.authorized) {

        setStatus('authorized');

        scheduleReset(resetSeconds, false);

      } else {

        setStatus('denied');

        scheduleReset(resetSeconds, true);

      }

    } catch (err) {

      setResult({

        authorized: false,

        message: err.message || 'Error al validar acceso',

        name: '',

        idNumber: ''

      });

      setStatus('denied');

      scheduleReset(resetSeconds, true);

    } finally {

      setProcessing(false);

    }

  };



  const handleExceptionalEntry = async (e) => {

    e.preventDefault();

    if (!exceptionalReason.trim()) return;

    if (!result?.name && !result?.idNumber) return;



    setProcessing(true);

    clearResetTimer();



    try {

      const data = await apiFetch('/guard/exceptional-entry', {
        method: 'POST',
        token: authToken,
        body: {
          name: result.name || 'Sin nombre',
          idNumber: result.idNumber || '',
          reason: exceptionalReason.trim(),
          movementType: 'ingreso'
        }
      });



      setResult({

        authorized: true,

        name: result.name,

        idNumber: result.idNumber,

        message: data.message || 'Ingreso excepcional autorizado',

        authorizationLabel: 'Ingreso excepcional',

        authorizationType: 'ingreso_excepcional',

        relayTriggered: Boolean(data.access?.relay?.triggered)

      });

      setStatus('authorized');

      setShowExceptionalForm(false);

      scheduleReset(resetSeconds, false);

    } catch (err) {

      setResult((prev) => ({

        ...prev,

        exceptionalError: err.message

      }));

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

        <div className="kiosk-topbar-actions">
          <ManualDoorButton
            authToken={authToken}
            currentUser={currentUser}
            variant="kiosk"
            doorId={doorId}
            onSuccess={(message) => setDoorFeedback(message)}
            onError={(message) => setDoorFeedback(message)}
          />
          <button type="button" className="btn btn-secondary" onClick={onExit}>
            <LogOut size={18} /> Salir del molinete
          </button>
        </div>
      </div>

      {doorFeedback && (
        <p className="kiosk-door-feedback">{doorFeedback}</p>
      )}



      <div className="kiosk-layout">

        <div className="kiosk-scanner-panel">

          <ContinuousScanner

            onScan={handleScan}

            scannerId="kiosk-continuous-scanner"

            paused={status === 'processing' || showExceptionalForm}

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

              {result.idNumber && <p className="kiosk-person-meta">DNI {result.idNumber}</p>}

              {result.authorizationLabel && (

                <span className="kiosk-auth-badge success">{result.authorizationLabel}</span>

              )}

              {result.message && (

                <p className="kiosk-detail">{result.message}</p>

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

                {REASON_LABELS[result.denialReason] || REASON_LABELS[result.authorizationType] || 'Sin autorización'}

              </span>



              {canExceptionalEntry && !showExceptionalForm && (

                <div className="kiosk-exceptional-actions">

                  <button

                    type="button"

                    className="btn btn-primary kiosk-exceptional-btn"

                    onClick={() => {

                      clearResetTimer();

                      setShowExceptionalForm(true);

                    }}

                  >

                    Autorizar ingreso excepcional

                  </button>

                  <button type="button" className="btn btn-secondary" onClick={resetToListening}>

                    Escanear otro documento

                  </button>

                </div>

              )}



              {canExceptionalEntry && showExceptionalForm && (

                <form className="kiosk-exceptional-form" onSubmit={handleExceptionalEntry}>

                  <p className="kiosk-exceptional-label">

                    <AlertTriangle size={16} /> Motivo obligatorio del ingreso excepcional

                  </p>

                  <textarea

                    className="input-field kiosk-exceptional-textarea"

                    rows={3}

                    required

                    placeholder="Ej: autorizado por supervisor — carga urgente de grúa"

                    value={exceptionalReason}

                    onChange={(e) => setExceptionalReason(e.target.value)}

                    disabled={processing}

                  />

                  {result.exceptionalError && (

                    <p className="kiosk-exceptional-error">{result.exceptionalError}</p>

                  )}

                  <div className="kiosk-exceptional-form-actions">

                    <button

                      type="submit"

                      className="btn btn-primary"

                      disabled={processing || !exceptionalReason.trim()}

                    >

                      Confirmar y abrir molinete

                    </button>

                    <button

                      type="button"

                      className="btn btn-secondary"

                      disabled={processing}

                      onClick={() => setShowExceptionalForm(false)}

                    >

                      Cancelar

                    </button>

                  </div>

                </form>

              )}

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

