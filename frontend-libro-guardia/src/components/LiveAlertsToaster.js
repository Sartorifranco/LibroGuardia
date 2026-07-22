import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../services/api';
import {
  filterUnseenAlerts,
  markAlertSeen,
  subscribeAlertSeen
} from '../utils/liveAlertDedupe';

const POLL_MS = 12000;
const DISPLAY_MS = 8000;
const MAX_VISIBLE = 4;

function LiveAlertsToaster({ enabled = true, pollMs = POLL_MS }) {
  const { authToken, currentUser } = useAuth();
  const [visible, setVisible] = useState([]);
  const memorySeen = useRef(new Set());
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    markAlertSeen(id);
    memorySeen.current.add(id);
    setVisible((prev) => prev.filter((a) => a.id !== id));
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const enqueue = useCallback((alerts) => {
    const fresh = filterUnseenAlerts(alerts, memorySeen.current);
    if (!fresh.length) return;
    setVisible((prev) => {
      const existing = new Set(prev.map((a) => a.id));
      const toAdd = fresh.filter((a) => !existing.has(a.id));
      toAdd.forEach((a) => {
        markAlertSeen(a.id);
        memorySeen.current.add(a.id);
        const timer = setTimeout(() => dismiss(a.id), DISPLAY_MS);
        timers.current.set(a.id, timer);
      });
      return [...toAdd, ...prev].slice(0, MAX_VISIBLE);
    });
  }, [dismiss]);

  useEffect(() => subscribeAlertSeen((id) => {
    memorySeen.current.add(id);
    setVisible((prev) => prev.filter((a) => a.id !== id));
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
        // silencioso: no molestar si falla el poll
      }
    };

    tick();
    const id = setInterval(tick, Math.max(8000, pollMs));
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, authToken, currentUser, pollMs, enqueue]);

  useEffect(() => () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
  }, []);

  if (!visible.length) return null;

  return (
    <div className="live-alerts-stack" aria-live="polite" aria-relevant="additions">
      {visible.map((alert) => (
        <div
          key={alert.id}
          className={`live-alert-toast live-alert-toast--${alert.severity || 'warn'}`}
          role="status"
        >
          <AlertTriangle size={16} aria-hidden />
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
      ))}
    </div>
  );
}

export default LiveAlertsToaster;
