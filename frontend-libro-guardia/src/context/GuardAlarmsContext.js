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
import { useHubLive } from './HubLiveContext';
import { useRuntime } from './RuntimeContext';
import {
  applyAlarmEvent,
  guideFor,
  isOpenAlarm,
  nativeAlertsEnabled,
  playCriticalCue
} from '../utils/alarmGuide';

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
  const { authToken } = useAuth();
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
      const data = await apiFetch('/guard/live-alerts', {
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
    const pollMs = mode === 'lan' && connected ? 0 : 15000;
    if (!pollMs) return () => { cancelled = true; };
    const id = setInterval(reload, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authToken, mode, connected, reload]);

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

  const acknowledge = useCallback(async (id, note) => {
    const trimmed = String(note || '').trim();
    if (trimmed.length < 3) {
      throw new Error('La nota tiene que tener al menos 3 caracteres');
    }
    await apiFetch(`/guard/alarms/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
      token: authToken,
      body: { note: trimmed }
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
