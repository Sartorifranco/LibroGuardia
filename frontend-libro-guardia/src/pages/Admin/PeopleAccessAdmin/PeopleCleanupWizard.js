import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Sparkles, AlertTriangle, Eraser } from 'lucide-react';
import { apiFetch } from '../../../services/api';

const GROUP_META = {
  uniones: {
    label: 'Uniones BioStar ↔ empleado',
    hint: 'Misma persona en huella y nómina. Se conserva la ficha con DNI/legajo.'
  },
  dni: {
    label: 'DNI fecha / basura',
    hint: 'Busca DNI real en nómina (personalMaster) o en otra ficha con el mismo nombre.'
  },
  puertas: {
    label: 'Acceso a todas las puertas',
    hint: 'Corrige el efecto de la migración vieja (vacío = todas). Ahora vacío = ninguna.'
  },
  revisar: {
    label: 'Revisar (confianza media)',
    hint: 'Solo aceptá si estás seguro de que son la misma persona.'
  }
};

function SuggestionCard({ item, applyingId, onAccept, onAcceptAlt }) {
  const busy = applyingId === item.id;
  return (
    <div className="people-hub-alert-card people-cleanup__card">
      <div className="people-cleanup__card-body">
        <h5>{item.title}</h5>
        <p className="historial-meta">{item.detail}</p>
        {item.keepDni || item.mergeBio ? (
          <p className="historial-meta">
            DNI {item.keepDni || '—'} · bio {item.mergeBio || '—'}
            {item.score != null ? ` · ${Math.round(item.score * 100)}%` : ''}
          </p>
        ) : null}
        {item.badDni && item.dni ? (
          <p className="historial-meta">
            <AlertTriangle size={12} aria-hidden /> {item.badDni} → <strong>{item.dni}</strong>
          </p>
        ) : null}
        {item.before ? (
          <p className="historial-meta">
            Puertas: {(item.before || []).join(', ') || '—'} → {(item.after || []).join(', ') || '(ninguna)'}
          </p>
        ) : null}
      </div>
      <div className="people-hub-alert-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(applyingId)}
          onClick={() => onAccept(item)}
        >
          {busy ? 'Aplicando…' : 'Aceptar'}
        </button>
        {item.altDoors?.length && onAcceptAlt ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={Boolean(applyingId)}
            onClick={() => onAcceptAlt(item)}
          >
            Solo {item.altDoors[0]}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RetainSourcesPanel({ authToken, onDone, onError, onSuccess, confirm }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/admin/people/retain-sources-plan', {
        token: authToken,
        allowForbidden: true
      });
      setPlan(data.plan || null);
      setProgress(null);
    } catch (err) {
      onError?.(err.message || 'No se pudo calcular qué conservar');
    } finally {
      setLoading(false);
    }
  }, [authToken, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const runWipe = async () => {
    const n = plan?.summary?.deactivate || 0;
    if (n < 1) {
      onSuccess?.('No hay fichas de más para dar de baja');
      return;
    }
    const ok = await confirm?.({
      title: 'Conservar solo Nómina + BioStar',
      message: `Se darán de baja ${n} fichas que no son de la nómina ni de BioStar. No se borran (queda el historial), pero dejan de aparecer en Personas y no abren puertas. ¿Continuar?`,
      confirmLabel: 'Dar de baja el resto'
    });
    if (!ok) return;

    setRunning(true);
    let cursor = null;
    let totalDeactivated = 0;
    try {
      let done = false;
      let guard = 0;
      while (!done && guard < 500) {
        guard += 1;
        const step = await apiFetch('/admin/people/retain-sources-step', {
          method: 'POST',
          token: authToken,
          body: { cursor, batchSize: 40 }
        });
        totalDeactivated += step.deactivated || 0;
        cursor = step.cursor || cursor;
        done = Boolean(step.done);
        setProgress({ deactivated: totalDeactivated, done });
      }
      onSuccess?.(`Listo: ${totalDeactivated} fichas dadas de baja. Quedan nómina + BioStar.`);
      await load();
      onDone?.();
    } catch (err) {
      onError?.(err.message || 'Falló la limpieza masiva');
    } finally {
      setRunning(false);
    }
  };

  if (loading && !plan) {
    return (
      <section className="people-cleanup__retain" role="status">
        <span>Calculando fichas a conservar…</span>
      </section>
    );
  }

  const s = plan?.summary || {};
  const samples = plan?.sampleDeactivate || [];

  return (
    <section className="people-cleanup__retain" aria-label="Conservar nómina y BioStar">
      <header className="people-cleanup__retain-head">
        <Eraser size={20} aria-hidden />
        <div>
          <h4>Conservar solo Nómina + BioStar</h4>
          <p>
            Deja activas las fichas de la nómina importada y las de BioStar (huella).
            El resto se da de baja (no se borra el historial).
          </p>
        </div>
      </header>
      <ul className="people-cleanup__retain-stats">
        <li>
          <strong>{s.keep || 0}</strong>
          {' '}
          se conservan (
          {s.keepNomina || 0}
          {' '}
          nómina ·
          {' '}
          {s.keepBiostar || 0}
          {' '}
          BioStar)
        </li>
        <li>
          <strong>{s.deactivate || 0}</strong>
          {' '}
          a dar de baja
        </li>
        <li>
          <strong>{s.alreadyOut || 0}</strong>
          {' '}
          ya inactivas / fusionadas
        </li>
      </ul>
      {samples.length > 0 ? (
        <p className="historial-meta">
          Ejemplos a baja:
          {' '}
          {samples.slice(0, 8).map((x) => x.name).join(', ')}
          {samples.length > 8 ? '…' : ''}
        </p>
      ) : null}
      {progress ? (
        <p className="historial-meta" role="status">
          Progreso:
          {' '}
          {progress.deactivated}
          {' '}
          bajas…
        </p>
      ) : null}
      <div className="people-hub-alert-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={running || (s.deactivate || 0) < 1}
          onClick={runWipe}
        >
          {running ? 'Dando de baja…' : `Dar de baja ${s.deactivate || 0} fichas`}
        </button>
        <button type="button" className="btn btn-secondary" disabled={running} onClick={load}>
          Recalcular
        </button>
      </div>
    </section>
  );
}

/**
 * Asistente de limpieza: retención de fuentes + sugerencias puntuales.
 */
function PeopleCleanupWizard({ authToken, onDone, onError, onSuccess, confirm }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [applyingId, setApplyingId] = useState(null);
  const [tab, setTab] = useState('uniones');
  const [lastMsg, setLastMsg] = useState(null);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/admin/people/cleanup-plan', {
        token: authToken,
        allowForbidden: true
      });
      setPlan(data.plan || null);
      setLastMsg(null);
    } catch (err) {
      onError?.(err.message || 'No se pudo armar el plan de limpieza');
    } finally {
      setLoading(false);
    }
  }, [authToken, onError]);

  useEffect(() => {
    loadPlan();
  }, [loadPlan]);

  const acceptOne = async (item, actionOverride = null) => {
    if (!item?.action && !actionOverride) return;
    setApplyingId(item.id);
    try {
      const data = await apiFetch('/admin/people/cleanup-action', {
        method: 'POST',
        token: authToken,
        body: { action: actionOverride || item.action }
      });
      const applied = Number(data.report?.applied || 0);
      const errors = data.report?.errors || [];
      if (errors.length || applied < 1) {
        onError?.(errors[0]?.message || 'La sugerencia no se aplicó');
        await loadPlan();
        return;
      }

      setPlan((prev) => {
        if (!prev?.groups) return prev;
        const strip = (list = []) => list.filter((s) => s.id !== item.id);
        const groups = {
          uniones: strip(prev.groups.uniones),
          dni: strip(prev.groups.dni),
          puertas: strip(prev.groups.puertas),
          revisar: strip(prev.groups.revisar)
        };
        return {
          ...prev,
          groups,
          suggestions: (prev.suggestions || []).filter((s) => s.id !== item.id),
          summary: {
            ...(prev.summary || {}),
            suggestions: Math.max(0, (prev.summary?.suggestions || 1) - 1)
          }
        };
      });
      onSuccess?.(data.message || 'Sugerencia aplicada');
      setLastMsg(data.message || 'OK');
      const fresh = await apiFetch('/admin/people/cleanup-plan', {
        token: authToken,
        allowForbidden: true
      });
      if (fresh.plan) setPlan(fresh.plan);
      onDone?.();
    } catch (err) {
      onError?.(err.message || 'Falló al aplicar');
    } finally {
      setApplyingId(null);
    }
  };

  const acceptAltDoors = (item) => {
    acceptOne(item, {
      type: 'set_doors',
      personId: item.personId,
      doors: item.altDoors || [],
      note: `all_doors_default:${(item.altDoors || [])[0] || ''}`
    });
  };

  const groups = plan?.groups || {};
  const counts = {
    uniones: groups.uniones?.length || 0,
    dni: groups.dni?.length || 0,
    puertas: groups.puertas?.length || 0,
    revisar: groups.revisar?.length || 0
  };
  const list = groups[tab] || [];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="people-cleanup">
      <RetainSourcesPanel
        authToken={authToken}
        onDone={onDone}
        onError={onError}
        onSuccess={onSuccess}
        confirm={confirm}
      />

      <header className="people-cleanup__hero">
        <Sparkles size={22} aria-hidden />
        <div>
          <h4>Asistente de uniones / DNI / puertas</h4>
          <p>
            Cada tarjeta es una sugerencia puntual. Aceptá solo las que consideres correctas
            ({total} pendientes).
          </p>
        </div>
      </header>

      {loading && !plan ? (
        <div className="admin-empty admin-empty--loading" role="status">
          <span>Armando sugerencias de limpieza…</span>
        </div>
      ) : (
        <>
          <div className="people-cleanup__steps" role="tablist">
            {Object.keys(GROUP_META).map((key) => (
              <button
                key={key}
                type="button"
                className={`people-hub-tab${tab === key ? ' is-active' : ''}`}
                onClick={() => setTab(key)}
              >
                {GROUP_META[key].label}
                {' '}
                (
                {counts[key]}
                )
              </button>
            ))}
            <button
              type="button"
              className="btn btn-secondary-small"
              disabled={Boolean(applyingId)}
              onClick={loadPlan}
            >
              Recalcular
            </button>
          </div>

          {lastMsg ? (
            <p className="people-cleanup__ok" role="status">
              <CheckCircle2 size={16} aria-hidden />
              {' '}
              {lastMsg}
            </p>
          ) : null}

          <p className="historial-meta">{GROUP_META[tab]?.hint}</p>

          {list.length === 0 ? (
            <div className="admin-empty">
              <p>Nada pendiente en esta categoría.</p>
            </div>
          ) : (
            <div className="people-cleanup__list">
              {list.map((item) => (
                <SuggestionCard
                  key={item.id}
                  item={item}
                  applyingId={applyingId}
                  onAccept={acceptOne}
                  onAcceptAlt={item.altDoors?.length ? acceptAltDoors : null}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default PeopleCleanupWizard;
