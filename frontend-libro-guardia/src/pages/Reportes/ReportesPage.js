import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Download,
  Loader2,
  AlertTriangle
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from 'recharts';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import brand from '../../config/brand';
import { apiFetch } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { hasPermission } from '../../utils/permissions';
import { useAuth } from '../../context/AuthContext';

const toYmd = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const shiftDays = (ymd, delta) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return toYmd(dt);
};

const PRESETS = [
  { id: '7d', label: 'Últimos 7 días' },
  { id: '30d', label: 'Últimos 30 días' },
  { id: 'custom', label: 'Rango personalizado' }
];

const TYPE_COLORS = {
  personalIngreso: '#2563eb',
  personalEgreso: '#93c5fd',
  vehiculoIngreso: '#ea580c',
  vehiculoEgreso: '#fdba74',
  flotaIngreso: '#16a34a',
  flotaEgreso: '#86efac'
};

function ReportesPage() {
  const { currentUser } = useAuth();
  const { showError } = useToast();
  const canExport = hasPermission(currentUser, 'reports.export');

  const today = useMemo(() => toYmd(new Date()), []);
  const [preset, setPreset] = useState('7d');
  const [from, setFrom] = useState(() => shiftDays(toYmd(new Date()), -6));
  const [to, setTo] = useState(() => toYmd(new Date()));
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const applyPreset = (id) => {
    setPreset(id);
    if (id === '7d') {
      setTo(today);
      setFrom(shiftDays(today, -6));
    } else if (id === '30d') {
      setTo(today);
      setFrom(shiftDays(today, -29));
    }
  };

  const loadSummary = useCallback(async () => {
    if (!canExport || !from || !to) return;
    setLoading(true);
    try {
      const data = await apiFetch(
        `/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      setSummary(data);
    } catch (err) {
      if (!err.isSessionExpired) {
        showError(err.message || 'No se pudo cargar el reporte');
      }
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [canExport, from, to, showError]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const chartData = useMemo(() => {
    if (!summary?.dailySeries) return [];
    return summary.dailySeries.map((row) => ({
      ...row,
      label: row.date.slice(5) // MM-DD
    }));
  }, [summary]);

  const exportPdf = () => {
    if (!summary || exporting) return;
    setExporting(true);
    try {
      const doc = new jsPDF('landscape');
      doc.setFontSize(12);
      doc.text(brand.pdfSummaryReportTitle || brand.pdfReportTitle, 14, 16);
      doc.setFontSize(9);
      doc.text(`Período: ${summary.from} → ${summary.to}`, 14, 22);

      const t = summary.totals || {};
      doc.autoTable({
        startY: 28,
        head: [['Tipo', 'Ingresos', 'Egresos']],
        body: [
          ['Personal', t.personal?.ingreso ?? 0, t.personal?.egreso ?? 0],
          ['Vehículo externo', t.vehiculo?.ingreso ?? 0, t.vehiculo?.egreso ?? 0],
          ['Flota', t.flota?.ingreso ?? 0, t.flota?.egreso ?? 0],
          ['Ingresos excepcionales', t.exceptionalEntries ?? 0, '—']
        ],
        styles: {
          fontSize: 8,
          cellPadding: 2,
          textColor: [0, 0, 0]
        },
        headStyles: {
          fillColor: [0, 0, 0],
          textColor: [255, 255, 255],
          fontStyle: 'bold'
        },
        alternateRowStyles: { fillColor: [240, 240, 240] }
      });

      let y = (doc.lastAutoTable?.finalY || 60) + 8;
      doc.setFontSize(10);
      doc.text('Top denegados por persona', 14, y);
      doc.autoTable({
        startY: y + 4,
        head: [['Persona', 'Cantidad']],
        body: (summary.topDenialsByPerson || []).map((r) => [r.label, r.count]),
        styles: { fontSize: 8, cellPadding: 1.5, textColor: [0, 0, 0] },
        headStyles: {
          fillColor: [0, 0, 0],
          textColor: [255, 255, 255],
          fontStyle: 'bold'
        },
        alternateRowStyles: { fillColor: [240, 240, 240] }
      });

      y = (doc.lastAutoTable?.finalY || y) + 8;
      doc.text('Top denegados por puerta', 14, y);
      doc.autoTable({
        startY: y + 4,
        head: [['Puerta', 'Cantidad']],
        body: (summary.topDenialsByDoor || []).map((r) => [r.label, r.count]),
        styles: { fontSize: 8, cellPadding: 1.5, textColor: [0, 0, 0] },
        headStyles: {
          fillColor: [0, 0, 0],
          textColor: [255, 255, 255],
          fontStyle: 'bold'
        },
        alternateRowStyles: { fillColor: [240, 240, 240] }
      });

      doc.save(`reporte_gerencial_${summary.from}_${summary.to}.pdf`);
    } catch (err) {
      showError(err.message || 'Error al exportar PDF');
    } finally {
      setExporting(false);
    }
  };

  if (!canExport) {
    return (
      <section className="form-section">
        <p className="text-gray-500 text-center py-8">
          No tenés permiso para ver reportes gerenciales.
        </p>
      </section>
    );
  }

  const totals = summary?.totals;

  return (
    <section className="form-section reportes-page">
      <h2 className="text-2xl font-semibold text-red-700 mb-2 flex items-center gap-2">
        <BarChart3 size={24} /> Reportes
      </h2>
      <p className="theme-section-desc" style={{ marginBottom: '1.25rem' }}>
        Resumen gerencial por rango de fechas (agregado en el servidor). El dashboard de inicio
        sigue siendo la vista operativa del día.
      </p>

      <div className="historial-presets" role="group" aria-label="Rango de fechas">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`historial-preset-btn${preset === p.id ? ' is-active' : ''}`}
            onClick={() => applyPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <div className="reportes-date-row">
          <label>
            Desde
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Hasta
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
      )}

      <div className="reportes-toolbar">
        <span className="historial-meta">
          {from} → {to}
          {summary ? ` · ${summary.totals?.entriesScanned ?? 0} movimientos` : ''}
        </span>
        <button
          type="button"
          className="btn-primary"
          onClick={exportPdf}
          disabled={!summary || exporting || loading}
        >
          {exporting ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
          Exportar PDF
        </button>
      </div>

      {loading && (
        <p className="historial-meta flex items-center gap-2">
          <Loader2 size={16} className="spin" /> Calculando resumen…
        </p>
      )}

      {!loading && summary && (
        <>
          <div className="reportes-totals">
            <div className="reportes-total-card">
              <span className="reportes-total-label">Personal</span>
              <strong>
                {totals.personal.ingreso} / {totals.personal.egreso}
              </strong>
              <span className="reportes-total-hint">ingreso / egreso</span>
            </div>
            <div className="reportes-total-card">
              <span className="reportes-total-label">Vehículos externos</span>
              <strong>
                {totals.vehiculo.ingreso} / {totals.vehiculo.egreso}
              </strong>
              <span className="reportes-total-hint">ingreso / egreso</span>
            </div>
            <div className="reportes-total-card">
              <span className="reportes-total-label">Flota</span>
              <strong>
                {totals.flota.ingreso} / {totals.flota.egreso}
              </strong>
              <span className="reportes-total-hint">ingreso / egreso</span>
            </div>
            <div className="reportes-total-card reportes-total-card--warn">
              <span className="reportes-total-label">
                <AlertTriangle size={14} /> Excepcionales
              </span>
              <strong>{totals.exceptionalEntries}</strong>
              <span className="reportes-total-hint">ingresos en el período</span>
            </div>
          </div>

          <div className="reportes-chart-wrap">
            <h3 className="theme-section-title" style={{ fontSize: '1.05rem' }}>
              Serie diaria por tipo
            </h3>
            <div className="reportes-chart">
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="personalIngreso" name="Personal ing." stackId="p" fill={TYPE_COLORS.personalIngreso} />
                  <Bar dataKey="personalEgreso" name="Personal egr." stackId="p" fill={TYPE_COLORS.personalEgreso} />
                  <Bar dataKey="vehiculoIngreso" name="Vehículo ing." stackId="v" fill={TYPE_COLORS.vehiculoIngreso} />
                  <Bar dataKey="vehiculoEgreso" name="Vehículo egr." stackId="v" fill={TYPE_COLORS.vehiculoEgreso} />
                  <Bar dataKey="flotaIngreso" name="Flota ing." stackId="f" fill={TYPE_COLORS.flotaIngreso} />
                  <Bar dataKey="flotaEgreso" name="Flota egr." stackId="f" fill={TYPE_COLORS.flotaEgreso} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="reportes-tables">
            <div>
              <h3 className="theme-section-title" style={{ fontSize: '1.05rem' }}>
                Top 10 denegados — persona
              </h3>
              <table className="data-table reportes-table">
                <thead>
                  <tr>
                    <th>Persona</th>
                    <th>Cantidad</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary.topDenialsByPerson || []).length === 0 ? (
                    <tr>
                      <td colSpan={2}>Sin denegaciones en el período</td>
                    </tr>
                  ) : (
                    summary.topDenialsByPerson.map((row) => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="theme-section-title" style={{ fontSize: '1.05rem' }}>
                Top 10 denegados — puerta
              </h3>
              <table className="data-table reportes-table">
                <thead>
                  <tr>
                    <th>Puerta</th>
                    <th>Cantidad</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary.topDenialsByDoor || []).length === 0 ? (
                    <tr>
                      <td colSpan={2}>Sin denegaciones en el período</td>
                    </tr>
                  ) : (
                    summary.topDenialsByDoor.map((row) => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default ReportesPage;
