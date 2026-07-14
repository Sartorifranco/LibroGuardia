import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Loader2 } from 'lucide-react';
import { apiFetch } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { hasPermission, getDashboardProfile } from '../utils/permissions';

const BUCKET_LABELS = {
  expired: 'Vencidas',
  d7: 'Vencen en 7 días',
  d15: 'Vencen en 15 días',
  d30: 'Vencen en 30 días'
};

function canSeeAlerts(user) {
  if (!user) return false;
  const profile = getDashboardProfile(user);
  const roleOk = ['guardia', 'supervisor', 'admin'].includes(profile)
    || ['guardia', 'supervisor', 'admin'].includes(user.role);
  if (!roleOk) return false;
  return (
    hasPermission(user, 'entries.view') ||
    hasPermission(user, 'master.citaciones.read')
  );
}

function ExpirationAlertsBanner() {
  const { authToken, currentUser } = useAuth();
  const [alerts, setAlerts] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!authToken || !canSeeAlerts(currentUser)) return;
    setLoading(true);
    try {
      const data = await apiFetch('/guard/expiration-alerts', {
        token: authToken,
        allowForbidden: true
      });
      setAlerts(data);
    } catch (err) {
      console.error('Error al cargar alertas de vencimiento:', err);
      setAlerts(null);
    } finally {
      setLoading(false);
    }
  }, [authToken, currentUser]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canSeeAlerts(currentUser)) return null;

  const buckets = [
    { key: 'expired', items: alerts?.expired || [] },
    { key: 'd7', items: alerts?.endingIn7 || alerts?.d7 || [] },
    { key: 'd15', items: alerts?.endingIn15 || alerts?.d15 || [] },
    { key: 'd30', items: alerts?.endingIn30 || alerts?.d30 || [] }
  ].filter((b) => b.items.length > 0);

  if (loading && !alerts) {
    return (
      <div className="expiration-alerts expiration-alerts--loading">
        <Loader2 size={16} className="animate-spin" />
        <span>Revisando vencimientos de autorizaciones…</span>
      </div>
    );
  }

  if (!buckets.length) return null;

  return (
    <section className="expiration-alerts" aria-label="Alertas de vencimiento">
      <div className="expiration-alerts__header">
        <CalendarClock size={18} aria-hidden />
        <h3>Autorizaciones por vencer</h3>
      </div>
      <div className="expiration-alerts__grid">
        {buckets.map(({ key, items }) => (
          <div
            key={key}
            className={`expiration-alerts__card expiration-alerts__card--${key}`}
          >
            <div className="expiration-alerts__card-title">
              {key === 'expired' && <AlertTriangle size={14} aria-hidden />}
              <strong>{BUCKET_LABELS[key]}</strong>
              <span>{items.length}</span>
            </div>
            <ul>
              {items.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <span>{item.name || item.title || 'Sin nombre'}</span>
                  <small>
                    {item.endDate || '—'}
                    {item.typeLabel ? ` · ${item.typeLabel}` : ''}
                  </small>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export default ExpirationAlertsBanner;
