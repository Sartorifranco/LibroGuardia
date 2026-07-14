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

export function EntriesProvider({ children }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { enqueueEntry } = useOfflineQueue();
  const [entries, setEntries] = useState([]);
  const [entriesLoading, setEntriesLoading] = useState(false);

  /** Home / KPIs: solo el día local actual (no el histórico completo). */
  const reloadEntries = useCallback(async (silent = true) => {
    if (!currentUser || !authToken) {
      setEntries([]);
      return [];
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
      return next;
    } catch (err) {
      console.error('Error al cargar registros:', err);
      if (!silent && !err.isSessionExpired) {
        showError(err.message || 'Error al cargar registros');
      }
      return [];
    } finally {
      if (!silent) setEntriesLoading(false);
    }
  }, [authToken, currentUser, showError]);

  useEffect(() => {
    if (!currentUser || !authToken) {
      setEntries([]);
      return undefined;
    }
    reloadEntries(true);
    const timer = setInterval(() => reloadEntries(true), 15000);
    return () => clearInterval(timer);
  }, [currentUser, authToken, reloadEntries]);

  const addEntry = useCallback(async (type, data) => {
    if (!currentUser || !authToken) {
      showError('Debe iniciar sesión para registrar movimientos.');
      return null;
    }
    try {
      setEntriesLoading(true);
      const result = await apiFetch('/entries', {
        method: 'POST',
        token: authToken,
        body: { type, ...data }
      });

      if (result.access) {
        if (result.access.authorized && result.access.relay?.triggered) {
          showSuccess('Registro guardado y acceso habilitado (relevador SR201 activado).');
        } else if (result.access.authorized) {
          showSuccess(`Registro guardado. ${result.access.relay?.message || 'Acceso autorizado.'}`);
        } else {
          showError(result.access.message || 'Registro guardado, pero acceso denegado.');
        }
      } else {
        showSuccess('Registro guardado exitosamente.');
      }

      await reloadEntries(true);
      return result;
    } catch (e) {
      console.error('Error al añadir documento: ', e);
      if (e.isNetworkError || e.status === 0) {
        try {
          await enqueueEntry(type, data);
          showSuccess('Sin conexión — guardado localmente, se enviará solo cuando vuelva internet');
          return { offlineQueued: true };
        } catch (queueErr) {
          console.error('Error al encolar offline:', queueErr);
          showError('Sin conexión y no se pudo guardar localmente.');
          return null;
        }
      }
      if (!e.isSessionExpired) {
        showError(e.message || 'Error al guardar el registro. Por favor, inténtelo de nuevo.');
      }
      return null;
    } finally {
      setEntriesLoading(false);
    }
  }, [authToken, currentUser, enqueueEntry, reloadEntries, showError, showSuccess]);

  const clearEntries = useCallback(() => setEntries([]), []);

  const value = useMemo(() => ({
    entries,
    setEntries,
    entriesLoading,
    reloadEntries,
    addEntry,
    clearEntries
  }), [entries, entriesLoading, reloadEntries, addEntry, clearEntries]);

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
