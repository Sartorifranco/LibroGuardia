import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { apiFetch } from '../services/api';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { useOfflineQueue } from './OfflineQueueContext';
import { useHubLive } from './HubLiveContext';
import { toLocalYmd } from '../utils/historialFilters';
import { entryIdentity, normalizeAccessEntry } from '../utils/accessEventText';
import usePolling from '../hooks/usePolling';

const EntriesContext = createContext(null);
// Los movimientos propios se ven al instante (se recarga al registrar); los de otros puestos,
// en hasta 2 min. En LAN llegan además por SSE del hub.
const POLL_MIN_MS = 120000;
const POLL_MAX_MS = 300000;
/** Varias pantallas llaman reloadEntries tras cada registro: como mucho 1 request cada 3 s. */
export const RELOAD_MIN_INTERVAL_MS = 3000;

/** true si el registro quedó guardado o encolado para enviar después. */
export function wasEntryStored(outcome) {
  return outcome?.status === 'saved' || outcome?.status === 'queued';
}

export function EntriesProvider({ children }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { enqueueEntry } = useOfflineQueue();
  const { subscribe } = useHubLive();
  const [entries, setEntries] = useState([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesRefreshFailed, setEntriesRefreshFailed] = useState(false);
  const [entriesUpdatedAt, setEntriesUpdatedAt] = useState(null);
  // /auth/me devuelve un objeto nuevo en cada refresco: depender del id, no de la identidad.
  const userKey = currentUser ? String(currentUser.id || currentUser.username || 'user') : null;

  /** Home / KPIs: solo el día local actual (no el histórico completo). */
  const fetchEntries = useCallback(async (silent = true) => {
    if (!userKey || !authToken) {
      setEntries([]);
      setEntriesRefreshFailed(false);
      setEntriesUpdatedAt(null);
      return false;
    }
    try {
      if (!silent) setEntriesLoading(true);
      const today = toLocalYmd();
      const params = new URLSearchParams({
        startDate: today,
        endDate: today,
        limit: '200'
      });
      const data = await apiFetch(`/entries?${params.toString()}`, { token: authToken });
      const next = (data.entries || []).map(normalizeAccessEntry);
      setEntries(next);
      setEntriesUpdatedAt(new Date());
      setEntriesRefreshFailed(false);
      return true;
    } catch (err) {
      console.error('Error al cargar registros:', err);
      if (!err.isSessionExpired) {
        setEntriesRefreshFailed(true);
        if (!silent) {
          showError(err.message || 'Error al cargar registros');
        }
      }
      return false;
    } finally {
      if (!silent) setEntriesLoading(false);
    }
  }, [authToken, userKey, showError]);

  const fetchEntriesRef = useRef(fetchEntries);
  fetchEntriesRef.current = fetchEntries;
  const throttleRef = useRef({ lastAt: 0, inflight: null, trailing: null });

  /**
   * Recarga con throttle: si hubo una hace menos de 3 s (o hay una en curso),
   * programa UNA sola al final de la ventana para que lo recién registrado aparezca igual.
   */
  const reloadEntries = useCallback((silent = true) => {
    const st = throttleRef.current;
    const start = () => {
      st.lastAt = Date.now();
      const promise = fetchEntriesRef.current(silent).finally(() => {
        if (st.inflight === promise) st.inflight = null;
      });
      st.inflight = promise;
      return promise;
    };
    const wait = st.lastAt + RELOAD_MIN_INTERVAL_MS - Date.now();
    if (!st.inflight && wait <= 0) return start();
    if (!st.trailing) {
      st.trailing = setTimeout(() => {
        st.trailing = null;
        if (st.inflight) st.inflight.finally(start);
        else start();
      }, Math.max(wait, 0));
    }
    return st.inflight || Promise.resolve(true);
  }, []);

  useEffect(() => {
    // Cambio de usuario / token: la próxima recarga no espera el throttle.
    throttleRef.current.lastAt = 0;
    if (!userKey || !authToken) {
      setEntries([]);
      setEntriesRefreshFailed(false);
      setEntriesUpdatedAt(null);
    }
  }, [userKey, authToken]);

  useEffect(() => () => {
    const st = throttleRef.current;
    if (st.trailing) clearTimeout(st.trailing);
    st.trailing = null;
  }, []);

  useEffect(() => subscribe((event) => {
    if (event.type !== 'access' || !event.data) return;
    const entry = normalizeAccessEntry(event.data.entry || event.data);
    const key = entryIdentity(entry);
    setEntries((prev) => {
      if (prev.some((item) => entryIdentity(item) === key)) return prev;
      return [entry, ...prev].slice(0, 200);
    });
    setEntriesUpdatedAt(new Date());
    setEntriesRefreshFailed(false);
  }), [subscribe]);

  const pollEntries = useCallback(() => reloadEntries(true), [reloadEntries]);
  // Pausa con la pestaña oculta; backoff 2 min → 5 min si falla.
  usePolling(pollEntries, POLL_MIN_MS, {
    enabled: Boolean(userKey && authToken),
    maxBackoffMs: POLL_MAX_MS,
    resetKey: `${userKey}|${authToken}`
  });

  const addEntry = useCallback(async (type, data) => {
    if (!userKey || !authToken) {
      showError('Debe iniciar sesión para registrar movimientos.');
      return { status: 'error' };
    }
    try {
      setEntriesLoading(true);
      const result = await apiFetch('/entries', {
        method: 'POST',
        token: authToken,
        body: { type, ...data }
      });

      if (result.access) {
        const relay = result.access.relay || {};
        const queued = relay.via === 'local-queue' || relay.command === 'queued';
        if (result.access.authorized && queued) {
          showSuccess('Se registró el ingreso. Enviado, esperando confirmación.');
        } else if (result.access.authorized && relay.triggered) {
          showSuccess('Se registró el ingreso. La puerta se abrió.');
        } else if (result.access.authorized) {
          showSuccess('Se registró el ingreso.');
        } else {
          showError(result.access.message || 'Se registró, pero el ingreso no está autorizado.');
        }
      } else {
        showSuccess('Se registró el ingreso.');
      }

      await reloadEntries(true);
      return { status: 'saved', result };
    } catch (e) {
      console.error('Error al añadir documento: ', e);
      if (e.isNetworkError || e.status === 0) {
        try {
          await enqueueEntry(type, data);
          showSuccess('Sin conexión — guardado localmente, se enviará solo cuando vuelva internet');
          return { status: 'queued' };
        } catch (queueErr) {
          console.error('Error al encolar offline:', queueErr);
          showError('Sin conexión y no se pudo guardar localmente.');
          return { status: 'error' };
        }
      }
      if (!e.isSessionExpired) {
        showError(e.message || 'Error al guardar el registro. Por favor, inténtelo de nuevo.');
      }
      return { status: 'error' };
    } finally {
      setEntriesLoading(false);
    }
  }, [authToken, userKey, enqueueEntry, reloadEntries, showError, showSuccess]);

  const clearEntries = useCallback(() => setEntries([]), []);

  const value = useMemo(() => ({
    entries,
    setEntries,
    entriesLoading,
    entriesRefreshFailed,
    entriesUpdatedAt,
    reloadEntries,
    addEntry,
    clearEntries
  }), [
    entries,
    entriesLoading,
    entriesRefreshFailed,
    entriesUpdatedAt,
    reloadEntries,
    addEntry,
    clearEntries
  ]);

  return (
    <EntriesContext.Provider value={value}>
      {children}
    </EntriesContext.Provider>
  );
}

export function useEntries() {
  const ctx = useContext(EntriesContext);
  if (!ctx) {
    throw new Error('useEntries debe usarse dentro de EntriesProvider');
  }
  return ctx;
}

export default EntriesContext;
