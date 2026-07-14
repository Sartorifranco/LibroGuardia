import React, { useMemo, useState } from 'react';
import { ClipboardList, Download, File, FileSpreadsheet, FileText } from 'lucide-react';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { useEntries } from '../../context/EntriesContext';
import { useToast } from '../../context/ToastContext';
import { entryMatchesTypeFilter, getEntryTableDisplay } from '../../utils/entryDisplay';

/**
 * @param {{ view: 'reportes' | 'allRecords' }} props
 */
function HistorialPage({ view = 'reportes' }) {
  const { entries } = useEntries();
  const { showError } = useToast();

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reportTypeFilter, setReportTypeFilter] = useState('todos');
  const [allRecordsSearchTerm, setAllRecordsSearchTerm] = useState('');
  const [allRecordsTypeFilter, setAllRecordsTypeFilter] = useState('todos');
  const [allRecordsStartDate, setAllRecordsStartDate] = useState('');
  const [allRecordsEndDate, setAllRecordsEndDate] = useState('');

  const getFilteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      const entryDate = new Date(entry.timestamp);
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;
      if (end) end.setHours(23, 59, 59, 999);

      const matchesDate = (!start || entryDate >= start) && (!end || entryDate <= end);
      const matchesType = entryMatchesTypeFilter(entry, reportTypeFilter);
      return matchesDate && matchesType;
    });
  }, [entries, startDate, endDate, reportTypeFilter]);

  const getFilteredAllRecordsEntries = useMemo(() => {
    const lowerCaseSearchTerm = allRecordsSearchTerm.toLowerCase();
    return entries.filter((entry) => {
      const entryDate = new Date(entry.timestamp);
      const start = allRecordsStartDate ? new Date(allRecordsStartDate) : null;
      const end = allRecordsEndDate ? new Date(allRecordsEndDate) : null;
      if (end) end.setHours(23, 59, 59, 999);

      const matchesDate = (!start || entryDate >= start) && (!end || entryDate <= end);
      const matchesType = entryMatchesTypeFilter(entry, allRecordsTypeFilter);
      const matchesSearchTerm = Object.values(entry).some((value) =>
        String(value).toLowerCase().includes(lowerCaseSearchTerm)
      );
      return matchesDate && matchesType && matchesSearchTerm;
    });
  }, [entries, allRecordsSearchTerm, allRecordsTypeFilter, allRecordsStartDate, allRecordsEndDate]);

  const generateReportData = () => {
    let headers = [];
    const baseHeaders = ['Tipo de Registro', 'Fecha', 'Hora Registro', 'Hora Evento', 'Usuario que Registró'];
    const personalHeaders = ['Nombre', 'DNI/Legajo', 'Empresa', 'Destino'];
    const vehiculoHeaders = ['Patente', 'Marca/Modelo', 'Empresa', 'Conductor'];
    const flotaHeaders = ['Móvil', 'Chofer', 'Hora Programada', 'Hora Real'];
    const novedadHeaders = ['Descripción'];

    if (reportTypeFilter === 'todos') {
      headers = [...baseHeaders, 'Detalle 1', 'Detalle 2', 'Detalle 3', 'Detalle 4'];
    } else if (reportTypeFilter === 'personal') {
      headers = [...baseHeaders, ...personalHeaders];
    } else if (reportTypeFilter === 'vehiculo') {
      headers = [...baseHeaders, ...vehiculoHeaders];
    } else if (reportTypeFilter === 'flota') {
      headers = [...baseHeaders, ...flotaHeaders];
    } else if (reportTypeFilter === 'novedad') {
      headers = [...baseHeaders, ...novedadHeaders];
    }

    const data = getFilteredEntries.map((entry) => {
      const date = new Date(entry.timestamp);
      const commonDetails = [
        date.toLocaleDateString(),
        date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        entry.eventTime || 'N/A',
        entry.registeredByUsername || 'Desconocido'
      ];
      const { typeDisplay, specificDetails: entrySpecificDetails } = getEntryTableDisplay(entry);
      return [typeDisplay, ...commonDetails, ...entrySpecificDetails];
    });

    return { headers, data };
  };

  const handleDownloadCSV = () => {
    const { headers, data } = generateReportData();
    if (data.length === 0) {
      showError('No hay datos para generar el reporte CSV.');
      return;
    }
    const csvContent = [
      headers.join(','),
      ...data.map((row) => row.map((item) => `"${String(item).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', 'reporte_libro_guardia.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadPDF = () => {
    const { headers, data } = generateReportData();
    if (data.length === 0) {
      showError('No hay datos para generar el reporte PDF.');
      return;
    }

    const doc = new jsPDF('landscape');
    doc.setFontSize(12);
    doc.text('Reporte Libro de Novedades Bacar sa.', 14, 16);
    doc.setFontSize(10);
    doc.text(`Filtros: Tipo - ${reportTypeFilter === 'todos' ? 'Todos' : reportTypeFilter.charAt(0).toUpperCase() + reportTypeFilter.slice(1)}, Fechas: ${startDate || 'Inicio'} a ${endDate || 'Fin'}`, 14, 22);

    doc.autoTable({
      head: [headers],
      body: data,
      startY: 30,
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
      alternateRowStyles: {
        fillColor: [240, 240, 240]
      },
      bodyStyles: {
        textColor: [0, 0, 0]
      },
      didParseCell: function (cellData) {
        if (cellData.section === 'body' && cellData.column.index === 0) {
          cellData.cell.styles.fontStyle = 'bold';
          if (cellData.cell.raw.includes('INGRESO')) {
            cellData.cell.styles.textColor = [0, 128, 0];
          } else if (cellData.cell.raw.includes('EGRESO')) {
            cellData.cell.styles.textColor = [255, 0, 0];
          } else if (cellData.cell.raw.includes('NOVEDAD')) {
            cellData.cell.styles.textColor = [255, 165, 0];
          }
        }
      }
    });
    doc.save('reporte_libro_guardia.pdf');
  };

  const handleDownloadXLSX = () => {
    const { headers, data } = generateReportData();
    if (data.length === 0) {
      showError('No hay datos para generar el reporte XLSX.');
      return;
    }
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
    XLSX.writeFile(wb, 'reporte_libro_guardia.xlsx');
  };

  if (view === 'allRecords') {
    return (
      <section className="mt-8">
        <h2 className="text-2xl font-semibold text-red-700 mb-4 flex items-center gap-2">
          <ClipboardList size={24} /> Todos los Registros
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="md:col-span-2">
            <label htmlFor="allRecordsSearchTerm" className="block text-sm font-medium text-gray-700 mb-1">Buscar por palabra clave</label>
            <input
              type="text"
              id="allRecordsSearchTerm"
              value={allRecordsSearchTerm}
              onChange={(e) => setAllRecordsSearchTerm(e.target.value)}
              className="input-field bg-white"
              placeholder="Buscar en todos los campos..."
            />
          </div>
          <div>
            <label htmlFor="allRecordsTypeFilter" className="block text-sm font-medium text-gray-700 mb-1">Tipo de Registro</label>
            <select
              id="allRecordsTypeFilter"
              value={allRecordsTypeFilter}
              onChange={(e) => setAllRecordsTypeFilter(e.target.value)}
              className="input-field bg-white"
            >
              <option value="todos">Todos los Tipos</option>
              <option value="personal">Personal</option>
              <option value="vehiculo">Vehículos Externos</option>
              <option value="flota">Flota Interna</option>
              <option value="novedad">Novedades</option>
            </select>
          </div>
          <div>
            <label htmlFor="allRecordsStartDate" className="block text-sm font-medium text-gray-700 mb-1">Fecha Inicio</label>
            <input
              type="date"
              id="allRecordsStartDate"
              value={allRecordsStartDate}
              onChange={(e) => setAllRecordsStartDate(e.target.value)}
              className="input-field bg-white"
            />
          </div>
          <div>
            <label htmlFor="allRecordsEndDate" className="block text-sm font-medium text-gray-700 mb-1">Fecha Fin</label>
            <input
              type="date"
              id="allRecordsEndDate"
              value={allRecordsEndDate}
              onChange={(e) => setAllRecordsEndDate(e.target.value)}
              className="input-field bg-white"
            />
          </div>
        </div>

        {getFilteredAllRecordsEntries.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No hay registros que coincidan con los filtros seleccionados.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg shadow-md border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-black text-white">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Tipo de Registro</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Fecha</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Hora Registro</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Hora Evento</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Usuario que Registró</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 1</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 2</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 3</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 4</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {getFilteredAllRecordsEntries.map((entry) => {
                  const date = new Date(entry.timestamp);
                  const commonDetails = [
                    date.toLocaleDateString(),
                    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                    entry.eventTime || 'N/A',
                    entry.registeredByUsername || 'Desconocido'
                  ];
                  const { typeDisplay, specificDetails } = getEntryTableDisplay(entry);

                  return (
                    <tr key={entry._id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{typeDisplay}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[0]}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[1]}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[2]}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[3]}</td>
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
        )}
      </section>
    );
  }

  return (
    <div className="form-section">
      <h2 className="text-2xl font-semibold text-red-700 mb-4 flex items-center gap-2">
        <FileText size={24} /> Generar Reportes
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div>
          <label htmlFor="startDate" className="block text-sm font-medium text-gray-700 mb-1">Fecha Inicio</label>
          <input
            type="date"
            id="startDate"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="input-field bg-white"
          />
        </div>
        <div>
          <label htmlFor="endDate" className="block text-sm font-medium text-gray-700 mb-1">Fecha Fin</label>
          <input
            type="date"
            id="endDate"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="input-field bg-white"
          />
        </div>
        <div>
          <label htmlFor="reportTypeFilter" className="block text-sm font-medium text-gray-700 mb-1">Tipo de Reporte</label>
          <select
            id="reportTypeFilter"
            value={reportTypeFilter}
            onChange={(e) => setReportTypeFilter(e.target.value)}
            className="input-field bg-white"
          >
            <option value="todos">Todos los Tipos</option>
            <option value="personal">Personal</option>
            <option value="vehiculo">Vehículos Externos</option>
            <option value="flota">Flota Interna</option>
            <option value="novedad">Novedades</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-8">
        <button onClick={handleDownloadCSV} className="btn btn-secondary w-full sm:w-auto flex-1">
          <Download size={20} /> <File size={20} className="mr-1" /> Descargar CSV
        </button>
        <button onClick={handleDownloadPDF} className="btn btn-secondary w-full sm:w-auto flex-1">
          <Download size={20} /> <FileText size={20} className="mr-1" /> Descargar PDF
        </button>
        <button onClick={handleDownloadXLSX} className="btn btn-secondary w-full sm:w-auto flex-1">
          <Download size={20} /> <FileSpreadsheet size={20} className="mr-1" /> Descargar XLSX
        </button>
      </div>

      <h3 className="text-xl font-semibold text-gray-800 mb-3">Vista Previa del Reporte</h3>
      {getFilteredEntries.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No hay registros que coincidan con los filtros seleccionados.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg shadow-md border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-black text-white">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Tipo de Registro</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Fecha</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Hora Registro</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Hora Evento</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Usuario que Registró</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 1</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 2</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 3</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">Detalle 4</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {getFilteredEntries.map((entry) => {
                const date = new Date(entry.timestamp);
                const commonDetails = [
                  date.toLocaleDateString(),
                  date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                  entry.eventTime || 'N/A',
                  entry.registeredByUsername || 'Desconocido'
                ];
                const { typeDisplay, specificDetails } = getEntryTableDisplay(entry);

                return (
                  <tr key={entry._id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{typeDisplay}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[0]}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[1]}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[2]}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{commonDetails[3]}</td>
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
      )}
    </div>
  );
}

export default HistorialPage;
