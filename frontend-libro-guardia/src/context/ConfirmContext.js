import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from 'react';
import ConfirmDialog from '../components/ConfirmDialog';

const ConfirmContext = createContext(null);

const DEFAULT_OPTIONS = {
  title: 'Confirmar acción',
  message: 'Esta acción no se puede deshacer.',
  confirmLabel: 'Confirmar',
  cancelLabel: 'Cancelar',
  tone: 'danger'
};

export function ConfirmProvider({ children }) {
  const [state, setState] = useState({ open: false, options: DEFAULT_OPTIONS });
  const resolverRef = useRef(null);

  const close = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState((prev) => ({ ...prev, open: false }));
    if (resolve) resolve(result);
  }, []);

  const confirm = useCallback((options = {}) => {
    // Si ya hay un diálogo abierto, rechazar el anterior como cancelado
    if (resolverRef.current) {
      resolverRef.current(false);
      resolverRef.current = null;
    }

    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setState({
        open: true,
        options: { ...DEFAULT_OPTIONS, ...options }
      });
    });
  }, []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={state.open}
        title={state.options.title}
        message={state.options.message}
        confirmLabel={state.options.confirmLabel}
        cancelLabel={state.options.cancelLabel}
        tone={state.options.tone}
        onConfirm={() => close(true)}
        onCancel={() => close(false)}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm debe usarse dentro de ConfirmProvider');
  }
  return ctx;
}

export default ConfirmContext;
