import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { apiFetch } from '../services/api';

const CLOUD_STATE = {
  status: 'ready',
  mode: 'cloud',
  capabilities: [],
  cloudOnline: true,
  siteId: null,
  hubId: null,
  configVersion: null
};

const RuntimeContext = createContext({
  ...CLOUD_STATE,
  isLan: false,
  setCloudOnline: () => {},
  setConfigVersion: () => {}
});

export function RuntimeProvider({ children }) {
  const [state, setState] = useState({ ...CLOUD_STATE, status: 'loading' });

  const setCloudOnline = useCallback((cloudOnline) => {
    setState((prev) => (
      prev.mode === 'lan' ? { ...prev, cloudOnline: Boolean(cloudOnline) } : prev
    ));
  }, []);

  const setConfigVersion = useCallback((configVersion) => {
    setState((prev) => (prev.mode === 'lan' ? { ...prev, configVersion } : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch('/runtime', {
          token: null,
          skipSessionExpiry: true
        });
        if (cancelled) return;
        if (data && data.mode === 'lan') {
          setState({
            status: 'ready',
            mode: 'lan',
            capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
            cloudOnline: data.cloudOnline !== false,
            siteId: data.siteId || null,
            hubId: data.hubId || null,
            configVersion: data.configVersion ?? null
          });
          return;
        }
      } catch {
        // 404 o sin respuesta: la app está en la nube.
      }
      if (!cancelled) setState({ ...CLOUD_STATE, status: 'ready' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({
    ...state,
    isLan: state.mode === 'lan',
    setCloudOnline,
    setConfigVersion
  }), [state, setCloudOnline, setConfigVersion]);

  return (
    <RuntimeContext.Provider value={value}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntime() {
  return useContext(RuntimeContext);
}
