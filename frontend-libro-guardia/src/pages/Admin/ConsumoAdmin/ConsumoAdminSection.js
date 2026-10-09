import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, EmptyState, HelpTip, AdvancedSection, Modal, PageContainer } from '../../../components/admin-ui';
import { useToast } from '../../../context/ToastContext';
import './consumo.css';

const formatUsd = (value) => {
  const n = Number(value) || 0;
  if (n > 0 && n < 0.01) return 'US$ < 0,01';
  const formatted = n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `US$ ${formatted}`;
};

const formatCount = (value) => (Number(value) || 0).toLocaleString('es-AR');

const STATUS_LABEL = {
  ok: 'Dentro del tope',
  warn: 'Cerca del tope',
  over: 'Por encima del tope'
};

function DayChart({ days, freeReads, freeWrites }) {
  const scaleReads = Math.max(freeReads, ...days.map((day) => day.reads), 1);
  const scaleWrites = Math.max(freeWrites, ...days.map((day) => day.writes), 1);
  return (
    <div className="consumo-charts">
      <ChartRow title="Lecturas por día" quotaLabel="Tope gratis: 50.000" scale={scaleReads} quota={freeReads} days={days} field="reads" />
      <ChartRow title="Escrituras por día" quotaLabel="Tope gratis: 20.000" scale={scaleWrites} quota={freeWrites} days={days} field="writes" />
    </div>
  );
}

function ChartRow({ title, quotaLabel, scale, quota, days, field }) {
  const line = Math.min(100, (quota / scale) * 100);
  return (
    <figure className="consumo-chart">
      <figcaption>
        <strong>{title}</strong>
        <span>{quotaLabel}</span>
      </figcaption>
      <div className="consumo-chart__plot" role="img" aria-label={title}>
        <div className="consumo-chart__line" style={{ bottom: `${line}%` }} />
        <div className="consumo-chart__bars">
          {days.map((day) => {
            const value = day[field] || 0;
            const height = Math.max(value > 0 ? 4 : 0, (value / scale) * 100);
            return (
              <div key={`${field}-${day.date}`} className="consumo-chart__col" title={`${day.label}: ${formatCount(value)}`}>
                <div className="consumo-chart__bar" style={{ height: `${height}%` }} />
                <span>{day.short}</span>
              </div>
            );
          })}
        </div>
      </div>
    </figure>
  );
}

function ConsumoAdminSection() {
  const { authToken } = useAuth();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [budget, setBudget] = useState('5');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [budgetOpen, setBudgetOpen] = useState(false);
  const { showSuccess, showError } = useToast();

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/usage?days=30', { token: authToken });
      setReport(data);
      setBudget(String(data?.budgetUsd ?? data?.month?.budgetUsd ?? 5));
    } catch (err) {
      setError(err.message || 'No se pudo cargar el consumo.');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const chartDays = useMemo(() => (report?.days || []).map((day) => {
    const reads = day.real?.reads ?? day.measured?.totals?.reads ?? 0;
    const writes = day.real?.writes ?? day.measured?.totals?.writes ?? 0;
    const [, month, date] = String(day.date).split('-');
    return { date: day.date, label: day.date, short: `${date}/${month}`, reads, writes };
  }), [report]);

  const hasActivity = chartDays.some((day) => day.reads || day.writes)
    || (report?.topCategories || []).length > 0;

  const saveBudget = async () => {
    setSaving(true);
    setSavedMsg('');
    setError('');
    try {
      const saved = await apiFetch('/admin/usage/budget', {
        method: 'PUT',
        token: authToken,
        body: { monthlyBudgetUsd: Number(String(budget).replace(',', '.')) }
      });
      setSavedMsg(`Tope guardado: ${formatUsd(saved.monthlyBudgetUsd)}`);
      setBudgetOpen(false);
      showSuccess('Guardado');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo guardar el tope.');
      setError(err.message || 'No se pudo guardar el tope.');
    } finally {
      setSaving(false);
    }
  };

  const month = report?.month || {};
  const status = month.status || 'ok';

  return (
    <PageContainer width="medium">
    <section className="consumo-page">
      <PageHeader
        title="Consumo"
        purpose="Cuánto está gastando este sitio en la base de datos, y si nos vamos a pasar del tope del mes."
        howTo={[
          'Mirá el semáforo: verde está bien, amarillo se acerca, rojo ya se pasa.',
          'Si el rojo es por el GPS, los vehículos se consultan solos cada 5 minutos.',
          'El tope de abajo es el aviso nuestro. El de Google Cloud se configura aparte, en US$ 10.'
        ]}
        action={(
          <button type="button" className="aui-btn" onClick={() => setHelpOpen((open) => !open)}>
            ¿Qué es esto?
          </button>
        )}
      />

      {helpOpen ? (
        <HelpTip text="Una lectura es cada vez que el sistema mira un dato guardado. Una escritura es cada vez que anota algo o lo cambia. Google deja usar gratis 50.000 lecturas y 20.000 escrituras por día. Si nos pasamos, se cobra. Esta pantalla estima el mes y avisa si la proyección supera el tope." />
      ) : null}

      {loading ? <p className="consumo-status" role="status">Cargando el consumo…</p> : null}
      {error ? <p className="consumo-status consumo-status--error" role="alert">{error}</p> : null}

      {!loading && report?.alarm ? (
        <div className="consumo-alarm" role="alert">
          Este mes va camino a pasar el tope de {formatUsd(month.budgetUsd)}. Revisá quién consume, sobre todo el GPS.
        </div>
      ) : null}

      {!loading && report ? (
        <div className={`consumo-hero consumo-hero--${status}`}>
          <p><span>Este mes</span><strong>{formatUsd(month.estimatedUsd)} (estimado)</strong></p>
          <p><span>Proyección a fin de mes</span><strong>{formatUsd(month.projectedUsd)}</strong></p>
          <p><span>Tope</span><strong>{formatUsd(month.budgetUsd)}</strong></p>
          <p className="consumo-hero__light" aria-label={STATUS_LABEL[status] || status}>
            <i />
            {STATUS_LABEL[status] || status}
          </p>
        </div>
      ) : null}

      {!loading && report && !hasActivity ? (
        <EmptyState
          title="Todavía no hay consumo medido"
          text="Cuando el sistema empiece a anotar lecturas y escrituras, vas a ver acá el día a día. Puede tardar unos minutos."
          actionLabel="Actualizar"
          onAction={load}
        />
      ) : null}

      {!loading && report && hasActivity ? (
        <DayChart
          days={chartDays}
          freeReads={report.freeDaily?.reads || 50000}
          freeWrites={report.freeDaily?.writes || 20000}
        />
      ) : null}

      {!loading && report ? (
        <div className="consumo-who">
          <h3>¿Quién consume?</h3>
          {(report.topCategories || []).length === 0 ? (
            <p className="consumo-muted">Todavía no hay un grupo que se destaque.</p>
          ) : (
            <div className="consumo-table-wrap">
              <table className="consumo-table">
                <thead>
                  <tr>
                    <th>Quién</th>
                    <th>Lecturas</th>
                    <th>Escrituras</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topCategories.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.label}</strong>
                        <span>{row.note}</span>
                      </td>
                      <td>{formatCount(row.reads)}</td>
                      <td>{formatCount(row.writes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      <button type="button" className="btn btn-secondary" onClick={() => setBudgetOpen(true)}>Editar tope</button>
      {savedMsg ? <p className="consumo-muted" role="status">{savedMsg}</p> : null}
      <Modal
        open={budgetOpen}
        title="Tope del mes"
        description="Si la estimación pasa este número, avisamos."
        onClose={() => setBudgetOpen(false)}
        size="sm"
        dirty
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setBudgetOpen(false)}>Cancelar</button>
            <button type="submit" form="consumo-tope-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar tope'}
            </button>
          </>
        )}
      >
        <form id="consumo-tope-form" className="aui-field" onSubmit={(event) => { event.preventDefault(); saveBudget(); }}>
          <label htmlFor="consumo-tope">Tope del mes (dólares)</label>
          <input
            id="consumo-tope"
            inputMode="decimal"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </form>
      </Modal>

      {!loading && report && report.monitoring && !report.monitoring.available ? (
        <div className="consumo-banner" role="status">
          <strong>El consumo real de Google no está disponible.</strong>
          <p>{report.monitoring.reason || 'Hay que darle a la cuenta del servidor el rol Visor de Monitoring.'}</p>
          <p>Los números de arriba son una estimación propia. Para ver los de Google: en IAM de Google Cloud, a la cuenta que ejecuta las funciones, agregale el rol Visor de Monitoring (roles/monitoring.viewer).</p>
        </div>
      ) : null}

      <AdvancedSection title="Detalle para Sistemas">
        <p>La estimación descuenta la cuota gratis de cada día (50.000 lecturas, 20.000 escrituras y 20.000 borrados) y usa los precios de Firestore en São Paulo verificados el 8 de octubre de 2026.</p>
        <p>El aviso por mail (tipo usage_budget) sale como máximo una vez por día, en el control de equipos que ya corre cada 5 minutos. Hay que tener las notificaciones prendidas y un correo en ese aviso.</p>
        <p>En Google Cloud, Facturación → Presupuestos y alertas: creá un presupuesto de US$ 10 con avisos al 50 %, 90 % y 100 %.</p>
      </AdvancedSection>
    </section>
    </PageContainer>
  );
}

export default ConsumoAdminSection;
