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
import * as offlineQueue from '../utils/offlineQueue';

const OfflineQueueContext = createContext(null);

export function OfflineQueueProvider({ children }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const flushingRef = useRef(false);

  const refreshCount = useCallback(async () => {
    try {
      const n = await offlineQueue.count();
      setPendingCount(n);
    } catch (err) {
      console.error('Error al contar cola offline:', err);
    }
  }, []);

  const enqueueEntry = useCallback(async (type, data) => {
    await offlineQueue.enqueue({
      type: 'entry',
      payload: { type, ...data },
      createdAt: Date.now()
    });
    await refreshCount();
  }, [refreshCount]);

  const flushQueue = useCallback(async () => {
    if (!authToken || !currentUser || flushingRef.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    flushingRef.current = true;
    try {
      const pending = await offlineQueue.listPending();
      if (!pending.length) {
        await refreshCount();
        return;
      }

      let sent = 0;
      for (const item of pending) {
        try {
          if (item.type === 'entry' && item.payload) {
            await apiFetch('/entries', {
              method: 'POST',
              token: authToken,
              body: item.payload
            });
          }
          await offlineQueue.remove(item.id);
          sent += 1;
        } catch (err) {
          if (err.isNetworkError || err.status === 0) break;
          // Ítem inválido o error definitivo: eliminar para no bloquear la cola
          console.error('Error al reenviar ítem offline:', err);
          await offlineQueue.remove(item.id);
        }
      }

      await refreshCount();
      if (sent > 0) {
        showSuccess(
          sent === 1
            ? 'Se envió 1 registro pendiente guardado sin conexión.'
            : `Se enviaron ${sent} registros pendientes guardados sin conexión.`
        );
      }
    } catch (err) {
      console.error('Error al vaciar cola offline:', err);
      if (!err.isSessionExpired) {
        showError(err.message || 'No se pudieron enviar los registros pendientes.');
      }
    } finally {
      flushingRef.current = false;
    }
  }, [authToken, currentUser, refreshCount, showError, showSuccess]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount, currentUser]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      flushQueue();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [flushQueue]);

  // Al recuperar sesión con ítems pendientes e internet, intentar flush una vez.
  useEffect(() => {
    if (!authToken || !currentUser || !isOnline) return undefined;
    if (pendingCount <= 0) return undefined;
    const t = setTimeout(() => { flushQueue(); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al entrar en sesión
  }, [authToken, currentUser]);

  const value = useMemo(() => ({
    pendingCount,
    isOnline,
    enqueueEntry,
    flushQueue,
    refreshCount
  }), [pendingCount, isOnline, enqueueEntry, flushQueue, refreshCount]);

  return (
    <OfflineQueueContext.Provider value={value}>
      {children}
    </OfflineQueueContext.Provider>
  );
}

export function useOfflineQueue() {
  const ctx = useContext(OfflineQueueContext);
  if (!ctx) {
    throw new Error('useOfflineQueue debe usarse dentro de OfflineQueueProvider');
  }
  return ctx;
}

export default OfflineQueueContext;
