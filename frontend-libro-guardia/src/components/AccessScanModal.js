import React, { useEffect } from 'react';
import { ShieldCheck, ShieldX, Loader2, UserPlus, X, LogIn } from 'lucide-react';
import { playKioskSound } from '../utils/kioskSounds';

function AccessScanModal({
  open,
  status,
  result,
  canAuthorizeManual,
  canExceptionalEntry,
  onClose,
  onAuthorizeManual,
  onExceptionalEntry
}) {
  useEffect(() => {
    if (!open) return;
    if (status === 'authorized') playKioskSound('authorized');
    else if (status === 'denied') playKioskSound('denied');
    else if (status === 'connection_error') playKioskSound('connection_error');
  }, [open, status]);

  if (!open) return null;

  const movementType = result?.movementType || 'ingreso';
  const isEgreso = movementType === 'egreso';
  const displayName = result?.name || 'Persona';

  return (
    <div className="access-scan-overlay" role="dialog" aria-modal="true" aria-labelledby="access-scan-title">
      <div className={`access-scan-modal access-scan-modal--${status}`}>
        <button type="button" className="access-scan-close" onClick={onClose} aria-label="Cerrar">
          <X size={20} />
        </button>

        {status === 'processing' && (
          <div className="access-scan-body">
            <Loader2 className="animate-spin access-scan-spinner" size={52} />
            <h2 id="access-scan-title">Verificando acceso…</h2>
            {(result?.name || result?.idNumber) && (
              <p className="access-scan-preview">
                {result.name && <span>{result.name}</span>}
                {result.idNumber && <span>DNI {result.idNumber}</span>}
              </p>
            )}
            <p className="access-scan-hint">Consultando autorizaciones del día</p>
          </div>
        )}

        {status === 'authorized' && (
          <div className="access-scan-body">
            <div className="access-scan-verdict access-scan-verdict--ok">
              {isEgreso ? 'EGRESO' : 'HABILITADO'}
            </div>
            <ShieldCheck size={56} className="access-scan-icon-ok" />
            <h2 id="access-scan-title" className="access-scan-subtitle">
              {isEgreso ? 'Salida registrada' : 'Puede ingresar'}
            </h2>
            <p className="access-scan-name">{displayName}</p>
            {result?.idNumber && <p className="access-scan-meta">DNI {result.idNumber}</p>}
            {result?.message && (
              <p className="access-scan-message">{result.message}</p>
            )}
            <button type="button" className="btn btn-primary mt-4" onClick={onClose}>
              Continuar
            </button>
          </div>
        )}

        {status === 'denied' && (
          <div className="access-scan-body">
            <div className="access-scan-verdict access-scan-verdict--deny">
              RECHAZADO
            </div>
            <ShieldX size={56} className="access-scan-icon-deny" />
            <h2 id="access-scan-title" className="access-scan-subtitle">
              Sin autorización para ingresar
            </h2>
            {result?.name && <p className="access-scan-name">{result.name}</p>}
            {result?.idNumber && <p className="access-scan-meta">DNI {result.idNumber}</p>}
            <p className="access-scan-message">
              {result?.message || 'No tiene autorización vigente para ingresar hoy.'}
            </p>
            <div className="access-scan-actions">
              {canAuthorizeManual && (
                <button type="button" className="btn btn-primary" onClick={onAuthorizeManual}>
                  <UserPlus size={18} /> Cargar autorización
                </button>
              )}
              {canExceptionalEntry && !canAuthorizeManual && (
                <button type="button" className="btn btn-primary" onClick={onExceptionalEntry}>
                  <LogIn size={18} /> Ingreso excepcional
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </div>
        )}

        {status === 'connection_error' && (
          <div className="access-scan-body">
            <div className="access-scan-verdict access-scan-verdict--warn">
              SIN CONEXIÓN
            </div>
            <ShieldX size={56} />
            <h2 id="access-scan-title" className="access-scan-subtitle">
              No se pudo verificar
            </h2>
            <p className="access-scan-message">
              Revisá internet y volvé a escanear.
            </p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default AccessScanModal;
