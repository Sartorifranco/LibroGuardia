import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Sparkles, AlertTriangle } from 'lucide-react';
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

/**
 * Asistente de limpieza: una sugerencia = un botón Aceptar.
 */
function PeopleCleanupWizard({ authToken, onDone, onError, onSuccess }) {
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
      if (data.report?.errors?.length) {
        onError?.(data.report.errors[0]?.message || 'Falló la sugerencia');
      } else {
        onSuccess?.(data.message || 'Sugerencia aplicada');
        setLastMsg(data.message || 'OK');
      }
      if (data.planAfter) setPlan(data.planAfter);
      else await loadPlan();
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

  if (loading || !plan) {
    return (
      <div className="admin-empty admin-empty--loading" role="status">
        <span>Armando sugerencias de limpieza…</span>
      </div>
    );
  }

  const groups = plan.groups || {};
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
      <header className="people-cleanup__hero">
        <Sparkles size={22} aria-hidden />
        <div>
          <h4>Asistente de limpieza</h4>
          <p>
            Cada tarjeta es una sugerencia. Aceptá solo las que consideres correctas
            ({total} pendientes).
          </p>
        </div>
      </header>

      <div className="people-cleanup__steps" role="tablist">
        {Object.keys(GROUP_META).map((key) => (
          <button
            key={key}
            type="button"
            className={`people-hub-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {GROUP_META[key].label} ({counts[key]})
          </button>
        ))}
        <button type="button" className="btn btn-secondary-small" disabled={Boolean(applyingId)} onClick={loadPlan}>
          Recalcular
        </button>
      </div>

      {lastMsg ? (
        <p className="people-cleanup__ok" role="status">
          <CheckCircle2 size={16} aria-hidden /> {lastMsg}
        </p>
      ) : null}

      <p className="historial-meta">{GROUP_META[tab]?.hint}</p>

      {list.length === 0 ? (
        <p className="historial-meta">No hay sugerencias en esta categoría.</p>
      ) : (
        <div className="people-cleanup__panel">
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

      {(plan.remainingBiostarOrphans || []).length > 0 && tab === 'uniones' ? (
        <section>
          <h4>Huérfanos BioStar sin match ({plan.remainingBiostarOrphans.length})</h4>
          <p className="historial-meta">
            Quedan sin pareja clara por nombre. Completá DNI a mano o unilos desde la ficha.
          </p>
          <div className="people-cleanup__table-wrap">
            <table className="people-access-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>ID biométrico</th>
                  <th>Puertas</th>
                </tr>
              </thead>
              <tbody>
                {(plan.remainingBiostarOrphans || []).slice(0, 40).map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.biometricExternalId || '—'}</td>
                    <td>{(p.doors || []).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {plan.summary?.allDoorsPeople > 0 && tab === 'puertas' ? (
        <p className="historial-meta">
          Hay {plan.summary.allDoorsPeople} personas con acceso a las {plan.activeDoorCount} puertas activas.
          Aceptá ficha por ficha, o usá “Solo {plan.defaultDoorId}” si corresponde al lector BioStar.
        </p>
      ) : null}
    </div>
  );
}

export default PeopleCleanupWizard;
