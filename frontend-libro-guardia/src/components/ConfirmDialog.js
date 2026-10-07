import React, { useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Modal de confirmación / alerta con el lenguaje visual de la app.
 * Si cancelLabel es null/false, es un aviso de un solo botón (Entendido).
 * El foco inicial va a Cancelar: un lector de DNI manda Enter y no debe confirmar.
 */
function ConfirmDialog({
  open,
  title = 'Confirmar acción',
  message = 'Esta acción no se puede deshacer.',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'danger',
  autoFocusConfirm = false,
  onConfirm,
  onCancel
}) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);

  const isDanger = tone === 'danger';
  const isAlert = cancelLabel == null || cancelLabel === false;
  const dismiss = isAlert ? onConfirm : onCancel;

  useEffect(() => {
    if (!open) return undefined;
    const target = autoFocusConfirm
      ? confirmRef.current
      : (cancelRef.current || dialogRef.current);
    target?.focus();
    return undefined;
  }, [open, autoFocusConfirm, isAlert]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay confirm-dialog-overlay"
      role="presentation"
      onClick={dismiss}
      onKeyDown={(e) => {
        if (e.key === 'Escape') dismiss?.();
      }}
    >
      <div
        ref={dialogRef}
        className="modal-content confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="close-button"
          onClick={dismiss}
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
        <p
          id="confirm-dialog-desc"
          className="confirm-dialog__message"
          style={{ whiteSpace: 'pre-line' }}
        >
          {message}
        </p>

        <div className="confirm-dialog__actions">
          {!isAlert ? (
            <button
              ref={cancelRef}
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          ) : null}
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${isDanger ? 'confirm-dialog__btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
