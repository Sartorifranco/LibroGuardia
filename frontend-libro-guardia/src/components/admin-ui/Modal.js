import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const SIZES = new Set(['sm', 'md', 'lg', 'xl']);

const isCancelButton = (button) => {
  if (!button || button.disabled) return false;
  if (button.getAttribute('data-aui-cancel') === 'true') return true;
  return (button.textContent || '').replace(/\s+/g, ' ').trim() === 'Cancelar';
};

/**
 * Ventana emergente centrada.
 * @param {{
 *   open: boolean,
 *   title: string,
 *   description?: string,
 *   onClose: () => void,
 *   children?: import('react').ReactNode,
 *   footer?: import('react').ReactNode,
 *   size?: 'sm'|'md'|'lg'|'xl',
 *   dirty?: boolean
 * }} props
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
  dirty = false
}) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef(null);
  const footerRef = useRef(null);
  const keepRef = useRef(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const sizeClass = SIZES.has(size) ? size : 'md';
  const dirtyRef = useRef(dirty);
  const askRef = useRef(askDiscard);
  dirtyRef.current = dirty;
  askRef.current = askDiscard;

  const requestClose = useCallback(() => {
    if (askRef.current) {
      setAskDiscard(false);
      return;
    }
    if (dirtyRef.current) {
      setAskDiscard(true);
      return;
    }
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!open) setAskDiscard(false);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const node = dialogRef.current;
    const previous = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFirst = () => {
      if (!node) return;
      const fields = node.querySelectorAll('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
      const field = [...fields].find((el) => !footerRef.current?.contains(el));
      (field || node.querySelector(FOCUSABLE) || node).focus();
    };
    const timer = setTimeout(focusFirst, 0);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = prevOverflow;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open]);

  useEffect(() => {
    if (askDiscard) keepRef.current?.focus();
  }, [askDiscard]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      const node = dialogRef.current;
      if (!node) return;
      if (!node.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...node.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, requestClose]);

  if (!open) return null;

  const discard = () => {
    setAskDiscard(false);
    onClose?.();
  };

  return (
    <div className="aui-modal-backdrop">
      <div
        ref={dialogRef}
        className={`aui-modal aui-modal--${sizeClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <header className="aui-modal__head">
          <div>
            <h2 id={titleId} className="aui-modal__title">{title}</h2>
            {description ? <p id={descId} className="aui-modal__desc">{description}</p> : null}
          </div>
          <button type="button" className="aui-modal__x" aria-label="Cerrar" onClick={requestClose}>
            ×
          </button>
        </header>
        <div className="aui-modal__body">{children}</div>
        {footer ? (
          <div
            ref={footerRef}
            className="aui-modal__footer"
            onClickCapture={(event) => {
              const button = event.target.closest?.('button');
              if (!button || !footerRef.current?.contains(button) || !isCancelButton(button)) return;
              event.preventDefault();
              event.stopPropagation();
              requestClose();
            }}
          >
            {footer}
          </div>
        ) : null}
        {askDiscard ? (
          <div className="aui-modal__discard" role="alertdialog" aria-label="¿Descartar los cambios?">
            <p>¿Descartar los cambios?</p>
            <div className="aui-modal__footer-right">
              <button ref={keepRef} type="button" className="btn btn-secondary" onClick={() => setAskDiscard(false)}>
                Cancelar
              </button>
              <button type="button" className="btn btn-danger-small" onClick={discard}>
                Descartar
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default Modal;
