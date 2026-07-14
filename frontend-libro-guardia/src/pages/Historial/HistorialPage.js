import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Download, File, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch } from '../../services/api';
import { getEntryTableDisplay } from '../../utils/entryDisplay';
import {
  HISTORIAL_DATE_PRESETS,
  resolveHistorialDateRange,
  toLocalYmd
} from '../../utils/historialFilters';
import { hasPermission } from '../../utils/permissions';

const TYPE_OPTIONS = [
  { value: 'todos', label: 'Todos los tipos' },
  { value: 'personal', label: 'Personal' },
  { value: 'vehiculo', label: 'Vehículos externos' },
  { value: 'flota', label: 'Flota interna' },
  { value: 'novedad', label: 'Novedades' }
];

const PAGE_SIZE = 50;
const EXPORT_MAX = 1000;

function HistorialPage() {
  const { authToken, currentUser } = useAuth();
  const { showError, showSuccess } = useToast();

  const canView = hasPermission(currentUser, 'entries.view');
  const canExport = hasPermission(currentUser, 'reports.export');

  const today = toLocalYmd();
  const [datePreset, setDatePreset] = useState('today');
  const [customStartDate, setCustomStartDate] = useState(today);
  const [customEndDate, setCustomEndDate] = useState(today);
  const [typeFilter, setTypeFilter] = useState('todos');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [entries, setEntries] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const requestIdRef = useRef(0);

  const { startDate, endDate } = useMemo(
    () => resolveHistorialDateRange(datePreset, customStartDate, customEndDate),
    [datePreset, customStartDate, customEndDate]
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const buildQuery = useCallback((cursor = null, limit = PAGE_SIZE) => {
    const params = new URLSearchParams({
      startDate,
      endDate,
      limit: String(limit),
      type: typeFilter || 'todos'
    });
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (cursor) params.set('cursor', cursor);
    return `/entries?${params.toString()}`;
  }, [startDate, endDate, typeFilter, debouncedSearch]);

  const fetchPage = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (!authToken || (!canView && !canExport)) return;
    const reqId = ++requestIdRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);

    try {
      const data = await apiFetch(buildQuery(cursor, PAGE_SIZE), { token: authToken });
      if (reqId !== requestIdRef.current) return;

      const pageEntries = data.entries || [];
      setEntries((prev) => (append ? [...prev, ...pageEntries] : pageEntries));
      setHasMore(Boolean(data.page?.hasMore));
      setNextCursor(data.page?.nextCursor || null);
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      if (!err.isSessionExpired) {
        showError(err.message || 'No se pudo cargar el historial');
      }
      if (!append) {
        setEntries([]);
        setHasMore(false);
        setNextCursor(null);
      }
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [authToken, buildQuery, canExport, canView, showError]);

  useEffect(() => {
    setEntries([]);
    setNextCursor(null);
    setHasMore(false);
    fetchPage({ append: false, cursor: null });
  }, [fetchPage]);

  const handlePresetChange = (presetId) => {
    setDatePreset(presetId);
    if (presetId !== 'custom') {
      const range = resolveHistorialDateRange(presetId);
      setCustomStartDate(range.startDate);
      setCustomEndDate(range.endDate);
    }
  };

  const handleLoadMore = () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    fetchPage({ append: true, cursor: nextCursor });
  };

  /** Carga el resto del rango (tope EXPORT_MAX) para exportar. */
  const loadAllForExport = async () => {
    let all = [...entries];
    let cursor = nextCursor;
    let more = hasMore;
    let loops = 0;

    while (more && cursor && all.length < EXPORT_MAX && loops < 40) {
      loops += 1;
      const data = await apiFetch(buildQuery(cursor, PAGE_SIZE), { token: authToken });
      const batch = data.entries || [];
      all = [...all, ...batch];
      more = Boolean(data.page?.hasMore);
      cursor = data.page?.nextCursor || null;
    }

    if (more) {
      showSuccess(`Exportando los primeros ${all.length} registros (límite ${EXPORT_MAX}).`);
    }
    return all;
  };

  const generateReportData = (sourceEntries) => {
    const baseHeaders = ['Tipo de Registro', 'Fecha', 'Hora Registro', 'Hora Evento', 'Usuario que Registró'];
    let headers = [...baseHeaders, 'Detalle 1', 'Detalle 2', 'Detalle 3', 'Detalle 4'];

    if (typeFilter === 'personal') {
      headers = [...baseHeaders, 'Nombre', 'DNI/Legajo', 'Empresa', 'Destino'];
    } else if (typeFilter === 'vehiculo') {
      headers = [...baseHeaders, 'Patente', 'Marca/Modelo', 'Empresa', 'Conductor'];
    } else if (typeFilter === 'flota') {
      headers = [...baseHeaders, 'Móvil', 'Chofer', 'Hora Programada / Patente', 'Hora Real'];
    } else if (typeFilter === 'novedad') {
      headers = [...baseHeaders, 'Descripción'];
    }

    const data = sourceEntries.map((entry) => {
      const date = new Date(entry.timestamp);
      const commonDetails = [
        date.toLocaleDateString(),
        date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        entry.eventTime || 'N/A',
        entry.registeredByUsername || 'Desconocido'
      ];
      const { typeDisplay, specificDetails } = getEntryTableDisplay(entry);
      const details = typeFilter === 'novedad'
        ? [specificDetails[0] || '']
        : specificDetails;
      return [typeDisplay, ...commonDetails, ...details];
    });

    return { headers, data };
  };

  const filterLabel = () => {
    const typeLabel = TYPE_OPTIONS.find((opt) => opt.value === typeFilter)?.label || typeFilter;
    const presetLabel = HISTORIAL_DATE_PRESETS.find((p) => p.id === datePreset)?.label || datePreset;
    return `Tipo: ${typeLabel} · Fechas (${presetLabel}): ${startDate || '—'} a ${endDate || '—'}${debouncedSearch ? ` · Buscar: "${debouncedSearch}"` : ''}`;
  };

  const runExport = async (kind) => {
    if (!canExport || exporting) return;
    setExporting(true);
    try {
      const source = await loadAllForExport();
      const { headers, data } = generateReportData(source);
      if (!data.length) {
        showError('No hay datos para exportar con estos filtros.');
        return;
      }

      if (kind === 'csv') {
        const csvContent = [
          headers.join(','),
          ...data.map((row) => row.map((item) => `"${String(item).replace(/"/g, '""')}"`).join(','))
        ].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', 'historial_libro_guardia.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else if (kind === 'pdf') {
        const doc = new jsPDF('landscape');
        doc.setFontSize(12);
        doc.text('Historial — Libro de Guardia Bacar S.A.', 14, 16);
        doc.setFontSize(9);
        doc.text(filterLabel(), 14, 22);
        doc.autoTable({
          head: [headers],
          body: data,
          startY: 28,
          styles: {
            fontSize: 7,
            cellPadding: 1,
            overflow: 'linebreak',
            halign: 'left',
            valign: 'middle',
            textColor: [0, 0, 0]
          },
          headStyles: {
            fillColor: [0, 0, 0],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 8
          },
          alternateRowStyles: { fillColor: [240, 240, 240] },
          bodyStyles: { textColor: [0, 0, 0] },
          didParseCell(cellData) {
            if (cellData.section === 'body' && cellData.column.index === 0) {
              cellData.cell.styles.fontStyle = 'bold';
              const raw = String(cellData.cell.raw || '');
              if (raw.includes('INGRESO')) cellData.cell.styles.textColor = [0, 128, 0];
              else if (raw.includes('EGRESO')) cellData.cell.styles.textColor = [255, 0, 0];
              else if (raw.includes('NOVEDAD')) cellData.cell.styles.textColor = [255, 165, 0];
            }
          }
        });
        doc.save('historial_libro_guardia.pdf');
      } else {
        const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Historial');
        XLSX.writeFile(wb, 'historial_libro_guardia.xlsx');
      }
    } catch (err) {
      if (!err.isSessionExpired) {
        showError(err.message || 'Error al exportar');
      }
    } finally {
      setExporting(false);
    }
  };

  if (!canView && !canExport) {
    return (
      <section className="form-section">
        <p className="text-gray-500 text-center py-8">No tenés permiso para ver el historial.</p>
      </section>
    );
  }

  return (
    <section className="form-section">
      <h2 className="text-2xl font-semibold text-red-700 mb-2 flex items-center gap-2">
        <ClipboardList size={24} /> Historial
      </h2>
      <p className="theme-section-desc" style={{ marginBottom: '1.25rem' }}>
        Se consultan solo los movimientos del rango elegido (por defecto <strong>hoy</strong>), no todo el histórico.
      </p>

      {!canView && canExport && (
        <div className="historial-export-only-note" role="status">
          No tenés permiso para ver el detalle de los registros, pero podés exportar el reporte.
        </div>
      )}

      <div className="historial-presets" role="group" aria-label="Rango de fechas">
        {HISTORIAL_DATE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`historial-preset-btn${datePreset === preset.id ? ' is-active' : ''}`}
            onClick={() => handlePresetChange(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        {datePreset === 'custom' && (
          <>
            <div>
              <label htmlFor="historialStartDate" className="block text-sm font-medium text-gray-700 mb-1">Fecha inicio</label>
              <input
                type="date"
                id="historialStartDate"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="input-field bg-white"
              />
            </div>
            <div>
              <label htmlFor="historialEndDate" className="block text-sm font-medium text-gray-700 mb-1">Fecha fin</label>
              <input
                type="date"
                id="historialEndDate"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="input-field bg-white"
              />
            </div>
          </>
        )}
        <div>
          <label htmlFor="historialTypeFilter" className="block text-sm font-medium text-gray-700 mb-1">Tipo de movimiento</label>
          <select
            id="historialTypeFilter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="input-field bg-white"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className={datePreset === 'custom' ? 'md:col-span-2' : 'md:col-span-3'}>
          <label htmlFor="historialSearch" className="block text-sm font-medium text-gray-700 mb-1">Buscar</label>
          <input
            type="text"
            id="historialSearch"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input-field bg-white"
            placeholder="Buscar en los resultados del rango..."
          />
        </div>
      </div>

      {canExport && (
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <span className="historial-export-label">Exportar (mismo rango):</span>
          <button type="button" disabled={exporting || loading} onClick={() => runExport('csv')} className="btn btn-secondary w-full sm:w-auto">
            <Download size={18} /> <File size={18} /> CSV
          </button>
          <button type="button" disabled={exporting || loading} onClick={() => runExport('pdf')} className="btn btn-secondary w-full sm:w-auto">
            <Download size={18} /> <FileText size={18} /> PDF
          </button>
          <button type="button" disabled={exporting || loading} onClick={() => runExport('xlsx')} className="btn btn-secondary w-full sm:w-auto">
            <Download size={18} /> <FileSpreadsheet size={18} /> Excel
          </button>
          {exporting && <span className="historial-export-label"><Loader2 size={16} className="animate-spin" /> Preparando…</span>}
        </div>
      )}

      {!canView && canExport && (
        <p className="theme-callout-info" style={{ marginBottom: '1rem' }}>
          Hay {entries.length} registro(s) cargados para exportar.
          La tabla en pantalla requiere permiso de ver registros.
        </p>
      )}

      {canView && (
        <>
          <p className="historial-meta">
            {loading ? 'Cargando…' : `${entries.length} registro(s) cargados`}
            {hasMore ? ' · hay más en este rango' : ''}
            {' · '}
            {filterLabel()}
          </p>

          {loading && entries.length === 0 ? (
            <p className="text-gray-500 text-center py-8 flex items-center justify-center gap-2">
              <Loader2 size={18} className="animate-spin" /> Cargando historial…
            </p>
          ) : entries.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No hay registros que coincidan con los filtros seleccionados.</p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg shadow-md border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-black text-white">
                    <tr>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Tipo</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Fecha</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Hora registro</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Hora evento</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Usuario</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 1</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 2</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 3</th>
                      <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 4</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {entries.map((entry) => {
                      const date = new Date(entry.timestamp);
                      const { typeDisplay, specificDetails } = getEntryTableDisplay(entry);
                      const rowKey = entry.id || entry._id || `${entry.timestamp}-${typeDisplay}`;
                      return (
                        <tr key={rowKey}>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{typeDisplay}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{date.toLocaleDateString()}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                            {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{entry.eventTime || 'N/A'}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                            {entry.registeredByUsername || 'Desconocido'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{specificDetails[0]}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{specificDetails[1]}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{specificDetails[2]}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{specificDetails[3]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {hasMore && (
                <div className="historial-load-more">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <><Loader2 size={16} className="animate-spin" /> Cargando…</>
                    ) : (
                      'Cargar más'
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export default HistorialPage;
