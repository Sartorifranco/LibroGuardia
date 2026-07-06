import React from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

function ToastStack({ error, successMessage, onDismissError, onDismissSuccess }) {
  if (!error && !successMessage) return null;

  return (
    <div className="toast-stack" aria-live="polite">
      {error && (
        <div className="toast toast-error" role="alert">
          <AlertCircle size={20} aria-hidden />
          <span>{error}</span>
          <button type="button" className="toast-close" onClick={onDismissError} aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
      )}
      {successMessage && (
        <div className="toast toast-success" role="status">
          <CheckCircle2 size={20} aria-hidden />
          <span>{successMessage}</span>
          <button type="button" className="toast-close" onClick={onDismissSuccess} aria-label="Cerrar">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export default ToastStack;
