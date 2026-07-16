import { useEffect, useRef } from 'react';

const SCAN_GAP_MS = 120;

const isTypingContext = () => {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (el.classList.contains('usb-scanner-input')) return false;
    if (el.classList.contains('global-scanner-capture')) return false;
    if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'button') return false;
    return true;
  }
  if (el.isContentEditable) return true;
  return false;
};

/**
 * Escucha escaneos de lector USB (keyboard wedge) a nivel documento.
 */
export function useUsbScanner({ enabled = false, paused = false, onScan }) {
  const bufferRef = useRef('');
  const lastKeyRef = useRef(0);
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled || paused) return undefined;

    const handleKeyDown = (event) => {
      if (isTypingContext()) return;
      if (event.repeat) return;

      if (event.key === 'Enter') {
        const value = bufferRef.current.trim();
        bufferRef.current = '';
        if (value) {
          event.preventDefault();
          event.stopPropagation();
          onScanRef.current?.(value);
        }
        return;
      }

      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;

      const now = Date.now();
      if (now - lastKeyRef.current > SCAN_GAP_MS) {
        bufferRef.current = '';
      }
      lastKeyRef.current = now;
      bufferRef.current += event.key;
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, paused]);
}
