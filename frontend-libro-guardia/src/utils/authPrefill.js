const AUTH_PREFILL_KEY = 'lg_auth_manual_prefill';

export const saveAuthManualPrefill = (prefill = {}) => {
  try {
    sessionStorage.setItem(AUTH_PREFILL_KEY, JSON.stringify({
      ...prefill,
      savedAt: Date.now()
    }));
  } catch {
    // sessionStorage no disponible
  }
};

export const consumeAuthManualPrefill = () => {
  try {
    const raw = sessionStorage.getItem(AUTH_PREFILL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(AUTH_PREFILL_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
