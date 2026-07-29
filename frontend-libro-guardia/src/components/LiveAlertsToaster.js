import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, Info, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../services/api';
import {
  filterUnseenAlerts,
  markAlertSeen,
  subscribeAlertSeen
} from '../utils/liveAlertDedupe';
import IdentityVerificationModal from './IdentityVerificationModal';

const POLL_MS = 5000;
const DISPLAY_MS = 8000;
const MAX_VISIBLE = 4;
const NOTIF_PREF_KEY = 'mss.guard.nativeNotifications';

const canUseNotifications = () =>
  typeof window !== 'undefined'
  && typeof Notification !== 'undefined';

const ensureNotificationPermission = async () => {
  if (!canUseNotifications()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
};

const showNativeNotification = (alert) => {
  if (!canUseNotifications() || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    return;
  }
  try {
    const n = new Notification(alert.title || 'MSS Guard', {
      body: alert.message || '',
      tag: alert.id,
      renotify: true,
      silent: false
    });
    setTimeout(() => {
      try { n.close(); } catch { /* ignore */ }
    }, 10000);
  } catch {
    // ignore
  }
};

function LiveAlertsToaster({ enabled = true, pollMs = POLL_MS }) {
  const { authToken, currentUser } = useAuth();
  const [visible, setVisible] = useState([]);
  const [identityQueue, setIdentityQueue] = useState([]);
  const [notifEnabled, setNotifEnabled] = useState(() => {
    try {
      return localStorage.getItem(NOTIF_PREF_KEY) === '1';
    } catch {
      return false;
    }
  });
  const memorySeen = useRef(new Set());
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    markAlertSeen(id);
    memorySeen.current.add(id);
    setVisible((prev) => prev.filter((a) => a.id !== id));
    setIdentityQueue((prev) => prev.filter((a) => a.id !== id));
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const enqueue = useCallback((alerts) => {
    const fresh = filterUnseenAlerts(alerts, memorySeen.current);
    if (!fresh.length) return;

    const identity = fresh.filter((a) => a.type === 'identity_verification');
    const toasts = fresh.filter((a) => a.type !== 'identity_verification');

    if (identity.length) {
      identity.forEach((a) => {
        // Solo memoria de sesión: persistir "visto" al cerrar el modal (dismiss).
        memorySeen.current.add(a.id);
        if (notifEnabled) showNativeNotification(a);
      });
      setIdentityQueue((prev) => {
        const existing = new Set(prev.map((a) => a.id));
        const toAdd = identity.filter((a) => !existing.has(a.id));
        return [...prev, ...toAdd];
      });
    }

    if (!toasts.length) return;
    setVisible((prev) => {
      const existing = new Set(prev.map((a) => a.id));
      const toAdd = toasts.filter((a) => !existing.has(a.id));
      toAdd.forEach((a) => {
        markAlertSeen(a.id);
        memorySeen.current.add(a.id);
        if (notifEnabled) showNativeNotification(a);
        const timer = setTimeout(() => dismiss(a.id), DISPLAY_MS);
        timers.current.set(a.id, timer);
      });
      return [...toAdd, ...prev].slice(0, MAX_VISIBLE);
    });
  }, [dismiss, notifEnabled]);

  useEffect(() => subscribeAlertSeen((id) => {
    memorySeen.current.add(id);
    setVisible((prev) => prev.filter((a) => a.id !== id));
    setIdentityQueue((prev) => prev.filter((a) => a.id !== id));
  }), []);

  useEffect(() => {
    if (!enabled || !authToken || !currentUser) return undefined;

    let cancelled = false;
    const tick = async () => {
      try {
        const data = await apiFetch('/guard/live-alerts', {
          token: authToken,
          allowForbidden: true
        });
        if (cancelled) return;
        enqueue(data.alerts || []);
      } catch {
        // silencioso
      }
    };

    tick();
    const id = setInterval(tick, Math.max(3000, pollMs));
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, authToken, currentUser, pollMs, enqueue]);

  useEffect(() => () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
  }, []);

  const enableNative = async () => {
    const ok = await ensureNotificationPermission();
    if (!ok) return;
    try {
      localStorage.setItem(NOTIF_PREF_KEY, '1');
    } catch { /* ignore */ }
    setNotifEnabled(true);
  };

  const activeIdentity = identityQueue[0] || null;

  return (
    <>
      {canUseNotifications() && !notifEnabled && Notification.permission !== 'denied' && (
        <button
          type="button"
          className="live-alerts-enable-native"
          onClick={enableNative}
          title="Avisos del sistema cuando hay ingresos/egresos"
        >
          <Bell size={14} />
          Activar avisos del sistema
        </button>
      )}
      {visible.length ? (
        <div className="live-alerts-stack" aria-live="polite" aria-relevant="additions">
          {visible.map((alert) => {
            const Icon = alert.severity === 'info' ? Info : AlertTriangle;
            return (
              <div
                key={alert.id}
                className={`live-alert-toast live-alert-toast--${alert.severity || 'warn'}`}
                role="status"
              >
                <Icon size={16} aria-hidden />
                <div className="live-alert-toast__body">
                  <strong>{alert.title}</strong>
                  <p>{alert.message}</p>
                </div>
                <button
                  type="button"
                  className="live-alert-toast__close"
                  onClick={() => dismiss(alert.id)}
                  aria-label="Cerrar alerta"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <IdentityVerificationModal
        alert={activeIdentity}
        onDismiss={dismiss}
      />
    </>
  );
}

export default LiveAlertsToaster;
