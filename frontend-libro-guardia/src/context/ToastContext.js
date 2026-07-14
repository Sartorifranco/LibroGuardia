import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  useEffect(() => {
    if (!successMessage) return undefined;
    const timer = setTimeout(() => setSuccessMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  const showSuccess = useCallback((message) => {
    setError(null);
    setSuccessMessage(message);
  }, []);

  const showError = useCallback((message) => {
    setSuccessMessage(null);
    setError(message);
  }, []);

  const clearMessages = useCallback(() => {
    setError(null);
    setSuccessMessage(null);
  }, []);

  const value = useMemo(() => ({
    error,
    successMessage,
    showSuccess,
    showError,
    clearMessages,
    setError,
    setSuccessMessage
  }), [error, successMessage, showSuccess, showError, clearMessages]);

  return (
    <ToastContext.Provider value={value}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast debe usarse dentro de ToastProvider');
  }
  return ctx;
}

export default ToastContext;
