import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { apiFetch } from '../services/api';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { useOfflineQueue } from './OfflineQueueContext';
import { toLocalYmd } from '../utils/historialFilters';

const EntriesContext = createContext(null);
const POLL_MIN_MS = 15000;
const POLL_MAX_MS = 60000;

/** true si el registro quedó guardado o encolado para enviar después. */
export function wasEntryStored(outcome) {
  return outcome?.status === 'saved' || outcome?.status === 'queued';
}

export function EntriesProvider({ children }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { enqueueEntry } = useOfflineQueue();
  const [entries, setEntries] = useState([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesRefreshFailed, setEntriesRefreshFailed] = useState(false);
  const [entriesUpdatedAt, setEntriesUpdatedAt] = useState(null);

  /** Home / KPIs: solo el día local actual (no el histórico completo). */
  const reloadEntries = useCallback(async (silent = true) => {
    if (!currentUser || !authToken) {
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
      const next = data.entries || [];
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
  }, [authToken, currentUser, showError]);

  useEffect(() => {
    if (!currentUser || !authToken) {
      setEntries([]);
      setEntriesRefreshFailed(false);
      setEntriesUpdatedAt(null);
      return undefined;
    }

    let cancelled = false;
    let timer = null;
    let delay = POLL_MIN_MS;

    const tick = async () => {
      const ok = await reloadEntries(true);
      if (cancelled) return;
      if (ok) delay = POLL_MIN_MS;
      timer = setTimeout(tick, delay);
      if (!ok) delay = Math.min(POLL_MAX_MS, delay * 2);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [currentUser, authToken, reloadEntries]);

  const addEntry = useCallback(async (type, data) => {
    if (!currentUser || !authToken) {
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
  }, [authToken, currentUser, enqueueEntry, reloadEntries, showError, showSuccess]);

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
