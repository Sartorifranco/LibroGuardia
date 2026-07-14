import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Loader2 } from 'lucide-react';
import { apiFetch } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { hasPermission, getDashboardProfile } from '../utils/permissions';

const BUCKET_LABELS = {
  expired: 'Vencidos',
  d7: 'Vencen en 7 días',
  d15: 'Vencen en 15 días',
  d30: 'Vencen en 30 días'
};

/** Misma matriz de dominios que el backend (resolveExpirationAlertScopes). */
export function resolveExpirationAlertScopes(user) {
  if (!user) {
    return { authorizations: false, personal: false, vehicles: false };
  }
  return {
    authorizations:
      hasPermission(user, 'entries.view') ||
      hasPermission(user, 'master.citaciones.read'),
    personal: hasPermission(user, 'master.personal.read'),
    vehicles: hasPermission(user, 'master.vehicles.read')
  };
}

function canSeeAlerts(user) {
  if (!user) return false;
  const profile = getDashboardProfile(user);
  const roleOk = ['guardia', 'supervisor', 'admin'].includes(profile)
    || ['guardia', 'supervisor', 'admin'].includes(user.role);
  if (!roleOk) return false;
  const scopes = resolveExpirationAlertScopes(user);
  return scopes.authorizations || scopes.personal || scopes.vehicles;
}

function kindAllowed(kind, scopes) {
  if (kind === 'authorization') return Boolean(scopes.authorizations);
  if (kind === 'art' || kind === 'license') return Boolean(scopes.personal);
  if (kind === 'insurance' || kind === 'vtv') return Boolean(scopes.vehicles);
  return false;
}

function filterBucketItems(items, scopes) {
  return (items || []).filter((item) => kindAllowed(item?.kind, scopes));
}

function ExpirationAlertsBanner() {
  const { authToken, currentUser } = useAuth();
  const [alerts, setAlerts] = useState(null);
  const [loading, setLoading] = useState(false);

  const scopes = useMemo(
    () => resolveExpirationAlertScopes(currentUser),
    [currentUser]
  );

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
    { key: 'expired', items: filterBucketItems(alerts?.expired, scopes) },
    { key: 'd7', items: filterBucketItems(alerts?.endingIn7 || alerts?.d7, scopes) },
    { key: 'd15', items: filterBucketItems(alerts?.endingIn15 || alerts?.d15, scopes) },
    { key: 'd30', items: filterBucketItems(alerts?.endingIn30 || alerts?.d30, scopes) }
  ].filter((b) => b.items.length > 0);

  const loadingHint = [
    scopes.authorizations && 'autorizaciones',
    scopes.personal && 'ART/licencia',
    scopes.vehicles && 'seguro/VTV'
  ].filter(Boolean).join(', ');

  if (loading && !alerts) {
    return (
      <div className="expiration-alerts expiration-alerts--loading">
        <Loader2 size={16} className="animate-spin" aria-hidden />
        <span>Revisando vencimientos ({loadingHint || 'documentos'})…</span>
      </div>
    );
  }

  if (!buckets.length) return null;

  return (
    <section className="expiration-alerts" aria-label="Alertas de vencimiento">
      <div className="expiration-alerts__header">
        <CalendarClock size={18} aria-hidden />
        <h3>Vencimientos próximos</h3>
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
              {items.slice(0, 6).map((item) => (
                <li key={item.id}>
                  <span>{item.message || item.name || item.title || 'Sin nombre'}</span>
                  {!item.message && (
                    <small>
                      {item.endDate || '—'}
                      {item.kindLabel ? ` · ${item.kindLabel}` : ''}
                      {item.typeLabel ? ` · ${item.typeLabel}` : ''}
                    </small>
                  )}
                  {item.message && item.kindLabel && (
                    <small>{item.kindLabel}{item.endDate ? ` · ${item.endDate}` : ''}</small>
                  )}
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
