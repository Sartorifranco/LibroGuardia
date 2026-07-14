import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState
} from 'react';

/**
 * Prefill de hora desde LiveClockBar hacia formularios operativos.
 * El shell setea el valor al navegar; cada page lo consume y limpia.
 */
const ClockPrefillContext = createContext(null);

export function ClockPrefillProvider({ children }) {
  const [prefill, setPrefill] = useState(null);
  // { tab: 'personal'|'vehiculo'|'flota'|'novedad', time: 'HH:MM', nonce: number }

  const setClockPrefill = useCallback((tab, time) => {
    if (!tab || !time) return;
    setPrefill({ tab, time, nonce: Date.now() });
  }, []);

  const consumePrefill = useCallback((tab) => {
    if (!prefill || prefill.tab !== tab) return null;
    const value = prefill.time;
    setPrefill(null);
    return value;
  }, [prefill]);

  const value = useMemo(() => ({
    prefill,
    setClockPrefill,
    consumePrefill
  }), [prefill, setClockPrefill, consumePrefill]);

  return (
    <ClockPrefillContext.Provider value={value}>
      {children}
    </ClockPrefillContext.Provider>
  );
}

export function useClockPrefill() {
  const ctx = useContext(ClockPrefillContext);
  if (!ctx) {
    throw new Error('useClockPrefill debe usarse dentro de ClockPrefillProvider');
  }
  return ctx;
}

export default ClockPrefillContext;
