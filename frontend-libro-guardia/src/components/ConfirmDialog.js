import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Modal de confirmación con el lenguaje visual de la app (overlay + card).
 */
function ConfirmDialog({
  open,
  title = 'Confirmar acción',
  message = 'Esta acción no se puede deshacer.',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'danger',
  onConfirm,
  onCancel
}) {
  if (!open) return null;

  const isDanger = tone === 'danger';

  return (
    <div
      className="modal-overlay confirm-dialog-overlay"
      role="presentation"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel?.();
      }}
    >
      <div
        className="modal-content confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="close-button"
          onClick={onCancel}
          aria-label="Cerrar"
        >
          <X size={18} />
        </button>

        <div className={`confirm-dialog__icon${isDanger ? ' confirm-dialog__icon--danger' : ''}`}>
          <AlertTriangle size={22} />
        </div>

        <h3 id="confirm-dialog-title" className="confirm-dialog__title">
          {title}
        </h3>
        <p id="confirm-dialog-desc" className="confirm-dialog__message">
          {message}
        </p>

        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${isDanger ? 'confirm-dialog__btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
