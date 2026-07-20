import React from 'react';
import { KeyRound } from 'lucide-react';
import ChangePasswordForm from './ChangePasswordForm';

/**
 * Modal bloqueante: no se puede cerrar sin cambiar la contraseña.
 */
function ForceChangePasswordModal({ username, onSubmit }) {
  return (
    <div className="modal-overlay change-password-overlay" role="dialog" aria-modal="true" aria-labelledby="force-change-password-title">
      <div className="modal-content change-password-modal">
        <div className="auth-brand" style={{ marginBottom: '1rem' }}>
          <KeyRound size={28} aria-hidden />
          <div>
            <h2 id="force-change-password-title" className="auth-title" style={{ fontSize: '1.25rem', margin: 0 }}>
              Cambiar contraseña
            </h2>
            <p className="auth-subtitle" style={{ margin: 0 }}>
              {username ? `${username} · ` : ''}Contraseña temporal o restablecida
            </p>
          </div>
        </div>
        <ChangePasswordForm forced onSubmit={onSubmit} />
      </div>
    </div>
  );
}

export default ForceChangePasswordModal;
