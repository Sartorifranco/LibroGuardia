import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Fingerprint, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../../services/api';

const POLL_MS = 20000;

const STATE_META = {
  ok: { label: 'Conectado', tone: 'ok' },
  stale: { label: 'Sin novedades', tone: 'warn' },
  error: { label: 'Con errores', tone: 'error' },
  unknown: { label: 'Sin datos', tone: 'off' }
};

const TONE_CLASS = {
  ok: ' access-gps-admin__stat--ok',
  warn: ' access-gps-admin__stat--warn',
  error: ' access-gps-admin__stat--warn',
  off: ' access-gps-admin__stat--off'
};

/** "hace 40 s" / "hace 12 min" / "hace 3 h" */
export const formatAge = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return 'sin datos';
  const secs = Math.floor(ms / 1000);
  if (secs < 10) return 'recién';
  if (secs < 60) return `hace ${secs} s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? '' : 's'}`;
};

export const formatMoment = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

/**
 * Semáforo de la conexión con BioStar 2 sobre el módulo Personas.
 * Refresca solo para que se vea en vivo si el puente dejó de reportar.
 */
function BiostarSyncStatus({ authToken }) {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  // Vuelve a renderizar las antigüedades aunque el fetch no traiga nada nuevo.
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const data = await apiFetch('/admin/biostar/status', {
        token: authToken,
        allowForbidden: true
      });
      if (!mounted.current) return;
      setStatus(data.status || null);
      setLoadError('');
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(err.message || 'No se pudo leer el estado de BioStar');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    mounted.current = true;
    load();
    const poll = setInterval(load, POLL_MS);
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  if (loadError && !status) {
    return (
      <div className="biostar-sync biostar-sync--error" role="status">
        <span className="biostar-sync__title">
          <Fingerprint size={16} /> BioStar 2
        </span>
        <span className="biostar-sync__error">{loadError}</span>
      </div>
    );
  }

  if (!status) return null;

  const users = status.users || {};
  const events = status.events || {};
  const meta = STATE_META[status.state] || STATE_META.unknown;
  // Las antigüedades del backend envejecen entre polls: se recalculan acá.
  const ageOf = (entry) => (entry?.at ? Date.now() - new Date(entry.at).getTime() : null);
  const usersAge = ageOf(users);
  const eventsAge = ageOf(events);
  const lastAny = [users.at, events.at]
    .filter(Boolean)
    .sort()
    .pop() || null;

  return (
    <div className={`biostar-sync biostar-sync--${meta.tone}`}>
      <div className="biostar-sync__head">
        <span className="biostar-sync__title">
          <Fingerprint size={16} />
          Conexión BioStar 2
        </span>
        <span className={`biostar-sync__pill biostar-sync__pill--${meta.tone}`}>
          <span className="biostar-sync__dot" aria-hidden />
          {meta.label}
        </span>
        <span className="biostar-sync__updated">
          Última actualización:{' '}
          <strong>{lastAny ? formatAge(Date.now() - new Date(lastAny).getTime()) : 'sin datos'}</strong>
          {lastAny ? ` · ${formatMoment(lastAny)}` : ''}
        </span>
        <button
          type="button"
          className="btn btn-secondary-small biostar-sync__refresh"
          onClick={load}
          disabled={loading}
          title="Actualizar estado ahora"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
          {loading ? ' Actualizando…' : ' Actualizar'}
        </button>
      </div>

      <div className="access-gps-admin__stats" aria-label="Estado de sincronización BioStar">
        <div className={`access-gps-admin__stat${TONE_CLASS[STATE_META[users.state]?.tone] || ''}`}>
          <span className="access-gps-admin__stat-label">Personas · última sync</span>
          <strong className="access-gps-admin__stat-value">{formatAge(usersAge)}</strong>
        </div>
        <div className="access-gps-admin__stat">
          <span className="access-gps-admin__stat-label">Usuarios en BioStar</span>
          <strong className="access-gps-admin__stat-value">{users.biostarTotal ?? '—'}</strong>
        </div>
        <div className="access-gps-admin__stat">
          <span className="access-gps-admin__stat-label">Altas / cambios</span>
          <strong className="access-gps-admin__stat-value">
            {users.created ?? 0} / {users.updated ?? 0}
          </strong>
        </div>
        <div className="access-gps-admin__stat">
          <span className="access-gps-admin__stat-label">Bajas aplicadas</span>
          <strong className="access-gps-admin__stat-value">
            {(users.deleted ?? 0) + (users.unlinked ?? 0) + (users.deactivated ?? 0)}
          </strong>
        </div>
        <div className={`access-gps-admin__stat${TONE_CLASS[STATE_META[events.state]?.tone] || ''}`}>
          <span className="access-gps-admin__stat-label">Pases · última sync</span>
          <strong className="access-gps-admin__stat-value">{formatAge(eventsAge)}</strong>
        </div>
        <div className="access-gps-admin__stat">
          <span className="access-gps-admin__stat-label">Pases importados</span>
          <strong className="access-gps-admin__stat-value">{events.accepted ?? 0}</strong>
        </div>
        {events.cursorDatetime && (
          <div className="access-gps-admin__stat access-gps-admin__stat--wide">
            <span className="access-gps-admin__stat-label">Historial al día hasta</span>
            <strong className="access-gps-admin__stat-value">{formatMoment(events.cursorDatetime)}</strong>
          </div>
        )}
        {status.bridge?.biostarHost && (
          <div className="access-gps-admin__stat access-gps-admin__stat--wide">
            <span className="access-gps-admin__stat-label">Puente</span>
            <strong className="access-gps-admin__stat-value">
              {status.bridge.hostname || 'equipo'} → {status.bridge.biostarHost}
            </strong>
          </div>
        )}
      </div>

      {users.reconcileSkippedReason && (
        <p className="biostar-sync__error">
          Bajas no aplicadas ({users.reconcileSkippedReason}). Revisá que BioStar esté devolviendo el padrón completo.
        </p>
      )}
      {users.ok === false && users.error && (
        <p className="biostar-sync__error">Error en personas: {users.error}</p>
      )}
      {events.ok === false && events.error && (
        <p className="biostar-sync__error">Error en pases: {events.error}</p>
      )}
    </div>
  );
}

export default BiostarSyncStatus;
