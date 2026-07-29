import { guardiaPath } from './navigation';

export const BOTONERA_WINDOW_NAME = 'mss-guard-botonera';

/**
 * Abre la botonera en una ventana aparte (segundo monitor).
 * @returns {Window|null} null si el navegador bloqueó el popup
 */
export function openBotoneraWindow() {
  if (typeof window === 'undefined') return null;
  const url = `${window.location.origin}${guardiaPath('botonera-ventana')}`;
  const features = [
    'noopener=yes',
    'noreferrer=yes',
    'width=1200',
    'height=860',
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no'
  ].join(',');
  try {
    const win = window.open(url, BOTONERA_WINDOW_NAME, features);
    if (win) {
      try { win.focus(); } catch { /* ignore */ }
    }
    return win;
  } catch {
    return null;
  }
}
