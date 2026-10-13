import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Modal de confirmación / alerta con el lenguaje visual de la app.
 * Si cancelLabel es null/false, es un aviso de un solo botón (Entendido).
 * El foco inicial va a Cancelar: un lector de DNI manda Enter y no debe confirmar.
 * Con reasonLabel muestra un campo de motivo obligatorio (mínimo minReasonLength
 * caracteres) y onConfirm recibe el motivo.
 */
function ConfirmDialog({
  open,
  title = 'Confirmar acción',
  message = 'Esta acción no se puede deshacer.',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'danger',
  autoFocusConfirm = false,
  reasonLabel = null,
  minReasonLength = 5,
  onConfirm,
  onCancel
}) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const [reason, setReason] = useState('');
  const withReason = Boolean(reasonLabel);
  const reasonOk = !withReason || reason.trim().length >= minReasonLength;

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

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

        {withReason ? (
          <label className="confirm-dialog__reason" style={{ display: 'block', textAlign: 'left', marginBottom: '0.75rem' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>{reasonLabel}</span>
            <textarea
              className="input-field"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label={reasonLabel}
            />
          </label>
        ) : null}

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
            onClick={() => (withReason ? onConfirm?.(reason.trim()) : onConfirm?.())}
            disabled={!reasonOk}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
