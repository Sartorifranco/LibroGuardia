import { useEffect } from 'react';

const isPageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Polling que se pausa con la pestaña oculta y refresca una vez al volver.
 *
 * - Usa setTimeout encadenado: nunca hay dos llamadas en curso a la vez.
 * - `callback` debe estar memoizado (useCallback); si cambia, el polling se reinicia
 *   y, con `immediate`, vuelve a llamar enseguida.
 * - `maxBackoffMs`: si el callback devuelve false (o lanza), duplica la espera
 *   hasta ese tope; un éxito la vuelve a `intervalMs`.
 * - `resetKey`: cualquier valor que, al cambiar, reinicia el polling (p. ej. el id de usuario).
 * - `pauseWhenHidden: false`: sigue con la pestaña oculta (p. ej. avisos nativos del sistema).
 *
 * @param {() => any|Promise<any>} callback
 * @param {number} intervalMs
 * @param {{ enabled?: boolean, immediate?: boolean, maxBackoffMs?: number|null, resetKey?: any,
 *   pauseWhenHidden?: boolean }} [options]
 */
export default function usePolling(callback, intervalMs, {
  enabled = true,
  immediate = true,
  maxBackoffMs = null,
  resetKey = null,
  pauseWhenHidden = true
} = {}) {
  useEffect(() => {
    const isHidden = () => pauseWhenHidden && isPageHidden();
    if (!enabled || typeof callback !== 'function' || !(intervalMs > 0)) return undefined;

    let cancelled = false;
    let running = false;
    let timer = null;
    let delay = intervalMs;

    const clear = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clear();
      if (cancelled || isHidden()) return;
      timer = setTimeout(tick, delay);
    };

    async function tick() {
      timer = null;
      if (cancelled || running || isHidden()) return;
      running = true;
      let result;
      try {
        result = await callback();
      } catch {
        result = false;
      }
      running = false;
      if (cancelled) return;
      if (maxBackoffMs) {
        delay = result === false ? Math.min(maxBackoffMs, delay * 2) : intervalMs;
      }
      schedule();
    }

    const onVisibility = () => {
      if (isPageHidden()) {
        if (pauseWhenHidden) clear();
        return;
      }
      if (!running) {
        clear();
        tick();
      }
    };

    if (immediate) tick();
    else schedule();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      cancelled = true;
      clear();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [callback, intervalMs, enabled, immediate, maxBackoffMs, resetKey, pauseWhenHidden]);
}

export { usePolling };
