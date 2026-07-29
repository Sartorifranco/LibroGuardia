import React from 'react';
import { Camera, ShieldCheck, UserRound, X } from 'lucide-react';

/**
 * Modal grande para que el guardia corrobore identidad en ingreso principal.
 */
function IdentityVerificationModal({ alert, onDismiss }) {
  if (!alert) return null;
  const meta = alert.meta || {};
  const photoUrl = meta.photoUrl || meta.photoDataUrl || '';
  const name = meta.name || alert.message?.split('·')[0]?.trim() || 'Persona';
  const idNumber = meta.idNumber || '';
  const doorName = meta.doorName || '';
  const company = meta.company || '';
  const authLabel = meta.authorizationLabel || meta.authorizationType || '';
  const legajo = meta.legajo || '';

  return (
    <div className="identity-verify-overlay" role="dialog" aria-modal="true" aria-labelledby="identity-verify-title">
      <div className="identity-verify-modal">
        <div className="identity-verify-modal__head">
          <div>
            <p className="identity-verify-modal__eyebrow">Ingreso principal · verificar identidad</p>
            <h2 id="identity-verify-title">{name}</h2>
          </div>
          <button
            type="button"
            className="identity-verify-modal__close"
            onClick={() => onDismiss?.(alert.id)}
            aria-label="Cerrar verificación"
          >
            <X size={20} />
          </button>
        </div>

        <div className="identity-verify-modal__grid">
          <div className={`identity-verify-modal__photo${photoUrl ? '' : ' is-empty'}`}>
            {photoUrl ? (
              <img src={photoUrl} alt={`Foto de ${name}`} />
            ) : (
              <div className="identity-verify-modal__no-photo">
                <Camera size={36} aria-hidden />
                <p>Sin foto cargada</p>
                <small>Corroborá con documento físico</small>
              </div>
            )}
          </div>
          <dl className="identity-verify-modal__facts">
            <div>
              <dt>DNI</dt>
              <dd>{idNumber || '—'}</dd>
            </div>
            {legajo ? (
              <div>
                <dt>Legajo</dt>
                <dd>{legajo}</dd>
              </div>
            ) : null}
            {company ? (
              <div>
                <dt>Empresa / área</dt>
                <dd>{company}</dd>
              </div>
            ) : null}
            {doorName ? (
              <div>
                <dt>Puerta</dt>
                <dd>{doorName}</dd>
              </div>
            ) : null}
            {authLabel ? (
              <div>
                <dt>Autorización</dt>
                <dd>{authLabel}</dd>
              </div>
            ) : null}
            <div className="identity-verify-modal__hint">
              <ShieldCheck size={16} aria-hidden />
              <span>Compará el rostro con la persona que está ingresando.</span>
            </div>
          </dl>
        </div>

        <div className="identity-verify-modal__footer">
          <p className="identity-verify-modal__who">
            <UserRound size={16} aria-hidden />
            {alert.message || 'Acceso autorizado en ingreso principal'}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => onDismiss?.(alert.id)}>
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}

export default IdentityVerificationModal;
