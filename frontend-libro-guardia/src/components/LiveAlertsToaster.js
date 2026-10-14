import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, Info, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../services/api';
import usePolling from '../hooks/usePolling';
import {
  filterUnseenAlerts,
  markAlertSeen,
  subscribeAlertSeen
} from '../utils/liveAlertDedupe';
import IdentityVerificationModal from './IdentityVerificationModal';
import { VISITOR_WINDOW_EVENT } from './VisitorAlertModal';

// El servidor cachea /guard/live-alerts 15 s: pedir más seguido no trae nada nuevo.
const POLL_MS = 60000;
// Con la pestaña oculta y los avisos del sistema activos, se sigue consultando pero más espaciado.
const HIDDEN_POLL_MS = 180000;
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
    const visitors = fresh.filter((a) => a.type === 'visitor_pass');
    const toasts = fresh.filter((a) => a.type !== 'identity_verification' && a.type !== 'visitor_pass');

    // 1b: visita/externo en puerta con aviso → cartel con sonido (VisitorAlertModal).
    visitors.forEach((a) => {
      memorySeen.current.add(a.id);
      if (notifEnabled) showNativeNotification(a);
      window.dispatchEvent(new CustomEvent(VISITOR_WINDOW_EVENT, { detail: a.meta }));
    });

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

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const pollAlerts = useCallback(async () => {
    try {
      const data = await apiFetch('/guard/live-alerts', {
        token: authToken,
        allowForbidden: true
      });
      if (!mountedRef.current) return;
      enqueue((data.alerts || []).filter((alert) => alert?.kind !== 'alarm'));
    } catch {
      // silencioso
    }
  }, [authToken, enqueue]);

  // Con la pestaña oculta se pausa, salvo que estén activos los avisos nativos del sistema
  // (que justamente se muestran cuando la pestaña no está a la vista).
  usePolling(pollAlerts, Math.max(3000, pollMs), {
    enabled: Boolean(enabled && authToken && currentUser),
    pauseWhenHidden: !notifEnabled,
    hiddenIntervalMs: HIDDEN_POLL_MS
  });

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
