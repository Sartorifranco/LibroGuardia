import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { API_BASE_URL } from '../services/api';
import { useAuth } from './AuthContext';
import { useRuntime } from './RuntimeContext';

const HubLiveContext = createContext({
  connected: false,
  subscribe: () => () => {}
});

const LIVE_EVENTS = ['door', 'access', 'alarm', 'config', 'runtime'];

export function HubLiveProvider({ children }) {
  const { authToken } = useAuth();
  const { mode, setCloudOnline, setConfigVersion } = useRuntime();
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef(new Set());

  const subscribe = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

  useEffect(() => {
    if (mode !== 'lan' || !authToken || typeof EventSource === 'undefined') {
      setConnected(false);
      return undefined;
    }

    let stopped = false;
    let source = null;
    let timer = null;
    let attempt = 0;

    const emit = (event) => {
      listenersRef.current.forEach((fn) => {
        try { fn(event); } catch { /* un oyente no corta el resto */ }
      });
    };

    const connect = () => {
      if (stopped) return;
      const url = `${API_BASE_URL}/live?token=${encodeURIComponent(authToken)}`;
      source = new EventSource(url);
      source.onopen = () => {
        attempt = 0;
        setConnected(true);
        emit({ type: 'status', connected: true });
      };
      LIVE_EVENTS.forEach((type) => {
        source.addEventListener(type, (ev) => {
          let data = null;
          try {
            data = ev?.data ? JSON.parse(ev.data) : null;
          } catch {
            data = null;
          }
          if (type === 'runtime' && data && typeof data.cloudOnline === 'boolean') {
            setCloudOnline(data.cloudOnline);
          }
          if (type === 'config' && data && data.configVersion != null) {
            setConfigVersion(data.configVersion);
          }
          emit({ type, data });
        });
      });
      source.onerror = () => {
        if (source) source.onerror = null;
        setConnected(false);
        emit({ type: 'status', connected: false });
        try { source?.close(); } catch { /* ignore */ }
        if (stopped) return;
        const delay = Math.min(20000, 1000 * (2 ** attempt));
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (source) source.onerror = null;
      try { source?.close(); } catch { /* ignore */ }
      setConnected(false);
    };
  }, [mode, authToken, setCloudOnline, setConfigVersion]);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);

  return (
    <HubLiveContext.Provider value={value}>
      {children}
    </HubLiveContext.Provider>
  );
}

export function useHubLive() {
  return useContext(HubLiveContext);
}
