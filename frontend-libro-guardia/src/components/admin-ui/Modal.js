import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const WIDTH = {
  sm: '420px',
  md: '640px',
  lg: '880px',
  xl: '1100px'
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const NARROW_QUERY = '(max-width: 639px)';

function focusableIn(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled'));
}

function firstField(root) {
  if (!root) return null;
  return root.querySelector(
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
  );
}

function useNarrowScreen() {
  const read = () => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(NARROW_QUERY).matches
  );
  const [narrow, setNarrow] = useState(read);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(media.matches);
    sync();
    if (media.addEventListener) media.addEventListener('change', sync);
    else if (media.addListener) media.addListener(sync);
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', sync);
      else if (media.removeListener) media.removeListener(sync);
    };
  }, []);

  return narrow;
}

function isCancelButton(node) {
  const button = node?.closest?.('button');
  if (!button || button.disabled) return false;
  const label = (button.textContent || '').replace(/\s+/g, ' ').trim();
  return label === 'Cancelar' || button.getAttribute('data-aui-cancel') === 'true';
}

/**
 * Ventana emergente centrada. Se cierra con Esc, la X y Cancelar.
 * Si `dirty` es true, pregunta antes de descartar.
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
  const onCloseRef = useRef(onClose);
  const dirtyRef = useRef(dirty);
  const [askDiscard, setAskDiscard] = useState(false);
  const narrow = useNarrowScreen();

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  useEffect(() => {
    if (!open) setAskDiscard(false);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const root = dialogRef.current;
    const target = firstField(root) || focusableIn(root)[0] || root;
    target?.focus();

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (askDiscard) {
          setAskDiscard(false);
          return;
        }
        if (dirtyRef.current) {
          setAskDiscard(true);
          return;
        }
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = focusableIn(dialogRef.current);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, askDiscard]);

  if (!open) return null;

  const requestClose = () => {
    if (dirtyRef.current) {
      setAskDiscard(true);
      return;
    }
    onCloseRef.current?.();
  };

  const discard = () => {
    setAskDiscard(false);
    onCloseRef.current?.();
  };

  const maxWidth = WIDTH[size] || WIDTH.md;
  const dialog = (
    <div className={`aui-modal-backdrop${narrow ? ' is-full' : ''}`} role="presentation">
      <div
        ref={dialogRef}
        className={`aui-modal aui-modal--${size}${narrow ? ' aui-modal--full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        data-size={size}
        tabIndex={-1}
        style={narrow
          ? { width: '100%', maxWidth: 'none', height: '100%', maxHeight: 'none' }
          : { width: '100%', maxWidth }}
      >
        <header className="aui-modal__head">
          <div>
            <h2 id={titleId} className="aui-modal__title">{title}</h2>
            {description ? <p id={descId} className="aui-modal__desc">{description}</p> : null}
          </div>
          <button type="button" className="aui-modal__close" onClick={requestClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </header>
        <div className="aui-modal__body">{children}</div>
        {footer ? (
          <div
            className="aui-modal__footer"
            onClickCapture={(event) => {
              if (!isCancelButton(event.target)) return;
              event.preventDefault();
              event.stopPropagation();
              requestClose();
            }}
          >
            {footer}
          </div>
        ) : null}
        {askDiscard ? (
          <div className="aui-modal__discard" role="alertdialog" aria-label="Descartar los cambios">
            <p>¿Descartar los cambios?</p>
            <div className="aui-modal__discard-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAskDiscard(false)}>
                Seguir editando
              </button>
              <button type="button" className="btn btn-primary" onClick={discard}>
                Descartar
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}

export default Modal;
