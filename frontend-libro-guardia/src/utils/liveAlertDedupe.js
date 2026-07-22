/**
 * Deduplicación cross-tab de alertas en vivo (BroadcastChannel + localStorage).
 */

const STORAGE_PREFIX = 'lg.liveAlert.seen.';
const CHANNEL_NAME = 'lg.live-alerts';
const SEEN_TTL_MS = 30 * 60 * 1000;

export function markAlertSeen(alertId) {
  if (!alertId || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${alertId}`, String(Date.now()));
  } catch {
    // quota / private mode
  }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(CHANNEL_NAME);
      ch.postMessage({ type: 'seen', id: alertId });
      ch.close();
    }
  } catch {
    // ignore
  }
}

export function wasAlertSeen(alertId) {
  if (!alertId || typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${alertId}`);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return true;
    if (Date.now() - ts > SEEN_TTL_MS) {
      localStorage.removeItem(`${STORAGE_PREFIX}${alertId}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function filterUnseenAlerts(alerts = [], memorySeen = new Set()) {
  return (alerts || []).filter((a) => {
    if (!a?.id) return false;
    if (memorySeen.has(a.id)) return false;
    if (wasAlertSeen(a.id)) return false;
    return true;
  });
}

export function subscribeAlertSeen(onSeen) {
  if (typeof window === 'undefined') return () => {};
  let ch = null;
  const onStorage = (e) => {
    if (!e.key || !e.key.startsWith(STORAGE_PREFIX) || !e.newValue) return;
    onSeen(e.key.slice(STORAGE_PREFIX.length));
  };
  window.addEventListener('storage', onStorage);
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      ch = new BroadcastChannel(CHANNEL_NAME);
      ch.onmessage = (ev) => {
        if (ev?.data?.type === 'seen' && ev.data.id) onSeen(ev.data.id);
      };
    }
  } catch {
    ch = null;
  }
  return () => {
    window.removeEventListener('storage', onStorage);
    try { ch?.close(); } catch { /* ignore */ }
  };
}
