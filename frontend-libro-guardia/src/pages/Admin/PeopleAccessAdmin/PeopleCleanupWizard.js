import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Sparkles, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../../services/api';

/**
 * Asistente de limpieza: 1 clic para lo seguro + revisión de dudosos.
 */
function PeopleCleanupWizard({ authToken, onDone, onError, onSuccess }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [step, setStep] = useState(1);
  const [selectedReview, setSelectedReview] = useState(() => new Set());
  const [lastReport, setLastReport] = useState(null);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/admin/people/cleanup-plan', {
        token: authToken,
        allowForbidden: true
      });
      setPlan(data.plan || null);
      const reviewIds = new Set(
        (data.plan?.review?.merges || []).map((m) => `${m.keepId}|${m.mergeId}`)
      );
      setSelectedReview(reviewIds);
      setLastReport(null);
    } catch (err) {
      onError?.(err.message || 'No se pudo armar el plan de limpieza');
    } finally {
      setLoading(false);
    }
  }, [authToken, onError]);

  useEffect(() => {
    loadPlan();
  }, [loadPlan]);

  const safeCount = useMemo(() => {
    if (!plan) return 0;
    return (plan.safe?.autoMerges?.length || 0)
      + (plan.safe?.repairBiostarDoors?.count ? 1 : 0)
      + (plan.safe?.clearSuspiciousDnis?.count ? 1 : 0);
  }, [plan]);

  const toggleReview = (key) => {
    setSelectedReview((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const applySafe = async () => {
    if (!plan) return;
    if (!window.confirm(
      '¿Aplicar limpieza segura?\n\n'
      + `• Unir ${plan.safe.autoMerges.length} fichas BioStar↔empleado (alta confianza)\n`
      + `• Corregir puertas de ${plan.safe.repairBiostarDoors.count} huérfanos BioStar → ${plan.defaultDoorId || '1 puerta'}\n`
      + `• Limpiar ${plan.safe.clearSuspiciousDnis.count} DNI basura/compartidos\n\n`
      + 'Las uniones conservan las puertas del empleado (no copian las puertas mal asignadas del huérfano).'
    )) return;

    setApplying(true);
    try {
      const data = await apiFetch('/admin/people/cleanup-apply', {
        method: 'POST',
        token: authToken,
        body: {
          clearSuspiciousDnis: true,
          repairBiostarDoors: true,
          applyAutoMerges: true,
          biostarDoorMode: 'single'
        }
      });
      setLastReport(data.report);
      onSuccess?.(data.message || 'Limpieza segura aplicada');
      setPlan(data.planAfter ? { ...plan, summary: data.planAfter, review: data.review } : plan);
      await loadPlan();
      setStep(2);
      onDone?.();
    } catch (err) {
      onError?.(err.message || 'Falló la limpieza');
    } finally {
      setApplying(false);
    }
  };

  const applyReview = async () => {
    const extra = (plan?.review?.merges || []).filter((m) =>
      selectedReview.has(`${m.keepId}|${m.mergeId}`)
    );
    if (!extra.length) {
      onError?.('No hay uniones seleccionadas');
      return;
    }
    if (!window.confirm(`¿Unir ${extra.length} pares seleccionados?`)) return;
    setApplying(true);
    try {
      const data = await apiFetch('/admin/people/cleanup-apply', {
        method: 'POST',
        token: authToken,
        body: {
          clearSuspiciousDnis: false,
          repairBiostarDoors: false,
          applyAutoMerges: false,
          extraMerges: extra
        }
      });
      onSuccess?.(data.message || 'Uniones aplicadas');
      await loadPlan();
      onDone?.();
    } catch (err) {
      onError?.(err.message || 'Falló al unir');
    } finally {
      setApplying(false);
    }
  };

  if (loading || !plan) {
    return (
      <div className="admin-empty admin-empty--loading" role="status">
        <span>Armando plan de limpieza…</span>
      </div>
    );
  }

  return (
    <div className="people-cleanup">
      <header className="people-cleanup__hero">
        <Sparkles size={22} aria-hidden />
        <div>
          <h4>Asistente de limpieza</h4>
          <p>
            Corrige de una vez el desorden BioStar + nómina: uniones claras, DNI basura y puertas
            mal asignadas a gente que no está en nómina.
          </p>
        </div>
      </header>

      <div className="people-cleanup__steps" role="tablist">
        <button
          type="button"
          className={`people-hub-tab${step === 1 ? ' is-active' : ''}`}
          onClick={() => setStep(1)}
        >
          1. Lo seguro ({safeCount})
        </button>
        <button
          type="button"
          className={`people-hub-tab${step === 2 ? ' is-active' : ''}`}
          onClick={() => setStep(2)}
        >
          2. Revisar ({plan.review?.merges?.length || 0})
        </button>
        <button
          type="button"
          className={`people-hub-tab${step === 3 ? ' is-active' : ''}`}
          onClick={() => setStep(3)}
        >
          3. Quedan ({plan.review?.remainingBiostarOrphans?.length || 0})
        </button>
      </div>

      {lastReport ? (
        <p className="people-cleanup__ok" role="status">
          <CheckCircle2 size={16} aria-hidden />
          Última corrida: {lastReport.merged} uniones · {lastReport.repairedDoors} puertas · {lastReport.clearedDnis} DNI
        </p>
      ) : null}

      {step === 1 && (
        <div className="people-cleanup__panel">
          <div className="people-hub-alert-card people-hub-alert-card--actions">
            <h5>Paquete seguro (recomendado)</h5>
            <ul className="people-cleanup__list">
              <li>
                <strong>{plan.safe.autoMerges.length}</strong> uniones BioStar → empleado (confianza alta).
                Conserva puertas del empleado.
              </li>
              <li>
                <strong>{plan.safe.repairBiostarDoors.count}</strong> huérfanos BioStar pasan a
                solo <code>{plan.defaultDoorId || '—'}</code> (deja de figurar en todas las puertas).
              </li>
              <li>
                <strong>{plan.safe.clearSuspiciousDnis.count}</strong> DNI basura/fecha/compartidos se vacían.
              </li>
            </ul>
            <div className="people-hub-alert-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={applying || safeCount === 0}
                onClick={applySafe}
              >
                {applying ? 'Aplicando…' : 'Aplicar limpieza segura'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={applying} onClick={loadPlan}>
                Recalcular
              </button>
            </div>
          </div>

          {plan.safe.autoMerges.length > 0 && (
            <section>
              <h4>Uniones automáticas (vista previa)</h4>
              <div className="people-cleanup__table-wrap">
                <table className="people-access-table">
                  <thead>
                    <tr>
                      <th>Se conserva</th>
                      <th>Se fusiona</th>
                      <th>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.safe.autoMerges.slice(0, 40).map((m) => (
                      <tr key={`${m.keepId}-${m.mergeId}`}>
                        <td>{m.keepName} · DNI {m.keepDni || '—'}</td>
                        <td>{m.mergeName} · bio {m.mergeBio || '—'}</td>
                        <td>{Math.round((m.score || 0) * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {plan.safe.clearSuspiciousDnis.groups?.length > 0 && (
            <section>
              <h4>DNI a limpiar</h4>
              {(plan.safe.clearSuspiciousDnis.groups || []).map((g) => (
                <div key={g.dni} className="people-hub-alert-card">
                  <h5><AlertTriangle size={14} aria-hidden /> {g.message}</h5>
                  <p className="historial-meta">{(g.names || []).join(' · ')}</p>
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="people-cleanup__panel">
          <p className="historial-meta">
            Casos dudosos: marcá los que sí son la misma persona y aplicá. Si no estás seguro, dejalo.
          </p>
          {(plan.review?.merges || []).length === 0 ? (
            <p className="historial-meta">No hay pares en revisión. Bien.</p>
          ) : (
            <>
              {(plan.review.merges || []).map((m) => {
                const key = `${m.keepId}|${m.mergeId}`;
                return (
                  <label key={key} className="people-hub-alert-card people-cleanup__review-row">
                    <input
                      type="checkbox"
                      checked={selectedReview.has(key)}
                      onChange={() => toggleReview(key)}
                    />
                    <span>
                      <strong>{m.mergeName}</strong> → <strong>{m.keepName}</strong>
                      {' '}({Math.round((m.score || 0) * 100)}%) · DNI {m.keepDni || '—'} · bio {m.mergeBio || '—'}
                    </span>
                  </label>
                );
              })}
              <div className="people-hub-alert-actions">
                <button type="button" className="btn btn-primary" disabled={applying} onClick={applyReview}>
                  Unir seleccionados
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="people-cleanup__panel">
          <p className="historial-meta">
            Quedan huérfanos BioStar sin match claro. Podés buscarlos en “Sin clasificar”, completar DNI
            o unir a mano desde la ficha.
          </p>
          <div className="people-cleanup__table-wrap">
            <table className="people-access-table">
              <thead>
                <tr>
                  <th>Nombre BioStar</th>
                  <th>ID biométrico</th>
                  <th>Puertas</th>
                </tr>
              </thead>
              <tbody>
                {(plan.review?.remainingBiostarOrphans || []).map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.biometricExternalId || '—'}</td>
                    <td>{(p.doors || []).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default PeopleCleanupWizard;
