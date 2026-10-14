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
import { hasPermission } from '../utils/permissions';
import { useHubLive } from './HubLiveContext';
import { useRuntime } from './RuntimeContext';
import usePolling from '../hooks/usePolling';
import {
  applyAlarmEvent,
  guideFor,
  isOpenAlarm,
  nativeAlertsEnabled,
  playCriticalCue
} from '../utils/alarmGuide';

export const ALARMS_POLL_MS = 45000;
export const ALARMS_HIDDEN_POLL_MS = 180000;

const GuardAlarmsContext = createContext({
  alarms: [],
  loading: false,
  error: '',
  acknowledge: async () => {}
});

function collectAlarms(data) {
  const list = data?.alerts || data?.alarms || [];
  return (Array.isArray(list) ? list : []).filter(isOpenAlarm);
}

export function GuardAlarmsProvider({ children }) {
  const { authToken: rawToken, currentUser } = useAuth();
  // Sin permiso de ver alarmas no se consulta (evita 403 cada 15 s y lecturas de más).
  const authToken = hasPermission(currentUser, 'alarmas.ver') ? rawToken : null;
  const { mode } = useRuntime();
  const { connected, subscribe } = useHubLive();
  const [alarms, setAlarms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const soundedRef = useRef(new Set());

  const reload = useCallback(async () => {
    if (!authToken) {
      setAlarms([]);
      return;
    }
    try {
      const data = await apiFetch('/guard/alarms?status=open&limit=50', {
        token: authToken,
        allowForbidden: true,
        dedupe: false
      });
      setAlarms(collectAlarms(data));
      setError('');
    } catch (err) {
      if (!err?.isForbidden) {
        setError(err.message || 'No se pudieron cargar las alarmas');
      }
    }
  }, [authToken]);

  useEffect(() => {
    if (!authToken) {
      setAlarms([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    reload().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [authToken, mode, connected, reload]);

  // En LAN con el hub conectado las alarmas llegan por SSE: no se consulta.
  // En la nube: cada 45 s a la vista; con la pestaña oculta solo si están activos los
  // avisos del sistema (suenan aunque no se mire), cada 3 min. Al volver, refresca enseguida.
  const livePushed = mode === 'lan' && connected;
  const backgroundAlerts = nativeAlertsEnabled();
  usePolling(reload, ALARMS_POLL_MS, {
    enabled: Boolean(authToken) && !livePushed,
    immediate: false,
    pauseWhenHidden: !backgroundAlerts,
    hiddenIntervalMs: ALARMS_HIDDEN_POLL_MS
  });

  useEffect(() => subscribe((event) => {
    if (event.type === 'alarm') {
      setAlarms((prev) => applyAlarmEvent(prev, event.data));
    }
    if (event.type === 'config') reload();
  }), [subscribe, reload]);

  useEffect(() => {
    if (!nativeAlertsEnabled()) return;
    alarms.forEach((alarm) => {
      if (!guideFor(alarm).critical) return;
      if (soundedRef.current.has(alarm.id)) return;
      soundedRef.current.add(alarm.id);
      playCriticalCue();
    });
  }, [alarms]);

  const acknowledge = useCallback(async (id, note, { close = false } = {}) => {
    const trimmed = String(note || '').trim();
    if (trimmed.length < 3) {
      throw new Error('La nota tiene que tener al menos 3 caracteres');
    }
    await apiFetch(`/guard/alarms/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
      token: authToken,
      body: close ? { note: trimmed, close: true } : { note: trimmed }
    });
    setAlarms((prev) => prev.filter((item) => item.id !== id));
  }, [authToken]);

  const value = useMemo(() => ({
    alarms,
    loading,
    error,
    acknowledge
  }), [alarms, loading, error, acknowledge]);

  return (
    <GuardAlarmsContext.Provider value={value}>
      {children}
    </GuardAlarmsContext.Provider>
  );
}

export function useGuardAlarms() {
  return useContext(GuardAlarmsContext);
}
