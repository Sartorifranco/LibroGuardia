import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { PlusCircle, Trash2, Upload, Loader2, Truck, PenLine, BadgeCheck } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';
import { AUTH_WEEKDAYS, AUTH_TYPE_LABELS, formatAuthSchedule } from '../adminConstants';
import { consumeAuthManualPrefill } from '../../../utils/authPrefill';

const AUTH_TABS = [
  {
    id: 'transporte',
    label: 'Citados transporte',
    icon: Truck,
    hint: 'Planillas de transporte, puente de carpeta e historial de importaciones.'
  },
  {
    id: 'manual',
    label: 'Carga manual',
    icon: PenLine,
    hint: 'Alta individual de visitas, temporales o accesos permanentes.'
  },
  {
    id: 'listado',
    label: 'Listado de autorizados',
    icon: BadgeCheck,
    hint: 'Visitas, contratistas y permanentes (no incluye citados de planilla).'
  }
];

/**
 * Sección "Autorizaciones" del panel de administración.
 * Separada en: citados transporte · carga manual · listado de autorizados.
 * @param {{ pendingAction: string|null, runAction: Function, setPendingAction: Function, authPrefillKey?: number }} props
 */
function CitacionesAdminSection({ pendingAction, runAction, setPendingAction, authPrefillKey = 0 }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError, setError } = useToast();
  const { confirm } = useConfirm();

  const [authTab, setAuthTab] = useState('transporte');
  const [loading, setLoading] = useState(false);
  const [selectedCitacionesFile, setSelectedCitacionesFile] = useState(null);
  const [citacionesBridgeConfig, setCitacionesBridgeConfig] = useState({
    enabled: false,
    bridgeSecret: '',
    watchFolderHint: 'C:\\usr',
    lastSyncAt: null,
    lastSyncFile: null,
    lastSyncCount: 0,
    lastSyncError: null
  });

  const [citaciones, setCitaciones] = useState([]);
  const [autorizados, setAutorizados] = useState([]);
  const [newCitacionName, setNewCitacionName] = useState('');
  const [newCitacionDni, setNewCitacionDni] = useState('');
  const [newCitacionCompany, setNewCitacionCompany] = useState('');
  const [newCitacionDestination, setNewCitacionDestination] = useState('');
  const [newCitacionDate, setNewCitacionDate] = useState(new Date().toISOString().slice(0, 10));
  const [citacionesViewDate, setCitacionesViewDate] = useState(new Date().toISOString().slice(0, 10));
  const [citacionesViewMode, setCitacionesViewMode] = useState('planned');
  const [citacionesRangeFrom, setCitacionesRangeFrom] = useState(new Date().toISOString().slice(0, 10));
  const [citacionesRangeTo, setCitacionesRangeTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [citacionesSearch, setCitacionesSearch] = useState('');
  const [citacionesFilterDate, setCitacionesFilterDate] = useState('');
  const [citacionesFilterFile, setCitacionesFilterFile] = useState('');
  const [citacionesImports, setCitacionesImports] = useState([]);
  const [plannedDates, setPlannedDates] = useState([]);
  const [autorizadosDate, setAutorizadosDate] = useState(new Date().toISOString().slice(0, 10));
  const [autorizadosSearch, setAutorizadosSearch] = useState('');
  const [autorizadosTypeFilter, setAutorizadosTypeFilter] = useState('');
  const [newAuthType, setNewAuthType] = useState('visita');
  const [newAuthStartDate, setNewAuthStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [newAuthEndDate, setNewAuthEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [newCitacionLegajo, setNewCitacionLegajo] = useState('');
  const [newAuthDaysOfWeek, setNewAuthDaysOfWeek] = useState(['Lu', 'Ma', 'Mi', 'Ju', 'Vi']);
  const [newAuthTimeFrom, setNewAuthTimeFrom] = useState('');
  const [newAuthTimeTo, setNewAuthTimeTo] = useState('');
  const [newAuthNotes, setNewAuthNotes] = useState('');
  const [newAuthPersonTipo, setNewAuthPersonTipo] = useState('visita');

  useEffect(() => {
    const prefill = consumeAuthManualPrefill();
    if (!prefill || prefill.exceptional) return;
    setAuthTab('manual');
    if (prefill.dni) setNewCitacionDni(String(prefill.dni));
    if (prefill.name) setNewCitacionName(String(prefill.name));
    setNewAuthType('visita');
    setNewAuthPersonTipo('visita');
  }, [authPrefillKey]);

  useEffect(() => {
    const fetchData = async () => {
      if (!currentUser || !hasPermission(currentUser, 'master.citaciones.read')) {
        setCitaciones([]);
        setAutorizados([]);
        return;
      }
      setLoading(true);
      try {
        if (authTab === 'listado') {
          const data = await apiFetch(
            `/admin/authorizations?scope=external&date=${autorizadosDate}`,
            { token: authToken, allowForbidden: true }
          );
          setAutorizados(data.authorizations || []);
        } else if (authTab === 'transporte') {
          let authQuery = '';
          if (citacionesViewMode === 'day') {
            authQuery = `date=${citacionesViewDate}&type=citacion`;
          } else if (citacionesViewMode === 'range') {
            authQuery = `from=${citacionesRangeFrom}&to=${citacionesRangeTo}&type=citacion`;
          } else {
            authQuery = `planned=true&date=${citacionesRangeFrom}`;
          }

          const data = await apiFetch(`/admin/authorizations?${authQuery}`, { token: authToken, allowForbidden: true });
          setCitaciones(data.authorizations || []);
          setPlannedDates(data.plannedDates || []);

          const importsData = await apiFetch('/admin/citaciones-imports?limit=100', { token: authToken, allowForbidden: true });
          setCitacionesImports(importsData.imports || []);
        }
      } catch (err) {
        console.error('Error al cargar autorizaciones:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [
    currentUser,
    authToken,
    authTab,
    citacionesViewDate,
    citacionesViewMode,
    citacionesRangeFrom,
    citacionesRangeTo,
    autorizadosDate
  ]);

  useEffect(() => {
    const fetchCitacionesBridge = async () => {
      if (!hasPermission(currentUser, 'master.citaciones.write')) return;
      try {
        const data = await apiFetch('/admin/citaciones-bridge', { token: authToken, allowForbidden: true });
        setCitacionesBridgeConfig((prev) => ({ ...prev, ...(data.config || {}) }));
      } catch (err) {
        console.error('Error al cargar puente de citaciones:', err);
      }
    };
    fetchCitacionesBridge();
  }, [currentUser, authToken]);

  const handleCreateCitacion = async (e) => {
    e.preventDefault();
    if (!newCitacionName.trim()) {
      showError('El nombre es obligatorio');
      return;
    }
    if (!newCitacionDni.trim() && !newCitacionLegajo.trim()) {
      showError('Indique DNI o legajo');
      return;
    }

    await runAction('createCitacion', async () => {
      try {
        const authType = newAuthType === 'visit' ? 'visita' : newAuthType;
        const payload = {
          type: authType,
          name: newCitacionName.trim(),
          idNumber: newCitacionDni.trim(),
          legajo: newCitacionLegajo.trim(),
          company: newCitacionCompany.trim(),
          destination: newCitacionDestination.trim(),
          personTipo: newAuthPersonTipo,
          notes: newAuthNotes.trim(),
          startDate: authType === 'citacion'
            ? newCitacionDate
            : newAuthStartDate,
          endDate: authType === 'permanent'
            ? null
            : authType === 'citacion'
              ? newCitacionDate
              : newAuthEndDate
        };

        if (authType === 'permanent') {
          payload.daysOfWeek = newAuthDaysOfWeek.length ? newAuthDaysOfWeek : null;
          if (newAuthTimeFrom && newAuthTimeTo) {
            payload.timeWindow = { from: newAuthTimeFrom, to: newAuthTimeTo };
          }
        }

        const data = await apiFetch('/admin/authorizations', {
          method: 'POST',
          token: authToken,
          body: payload
        });
        setNewCitacionName('');
        setNewCitacionDni('');
        setNewCitacionLegajo('');
        setNewCitacionCompany('');
        setNewCitacionDestination('');
        setNewAuthNotes('');
        showSuccess('Autorización cargada correctamente.');

        if (authType === 'citacion') {
          setCitaciones((prev) => [...prev, data.authorization]);
          setAuthTab('transporte');
        } else {
          setAutorizados((prev) => [...prev, data.authorization]);
          setAuthTab('listado');
        }
      } catch (err) {
        showError(err.message || 'Error al crear autorización');
      }
    });
  };

  const toggleAuthDay = (code) => {
    setNewAuthDaysOfWeek((prev) =>
      prev.includes(code) ? prev.filter((day) => day !== code) : [...prev, code]
    );
  };

  const handleDeleteCitacion = async (id, listKey = 'citaciones') => {
    const ok = await confirm({
      title: 'Desactivar autorización',
      message: 'La autorización quedará inactiva y dejará de permitir el ingreso.',
      confirmLabel: 'Desactivar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/admin/authorizations/${id}`, {
        method: 'DELETE',
        token: authToken
      });
      if (listKey === 'autorizados') {
        setAutorizados((prev) => prev.filter((item) => item.id !== id));
      } else {
        setCitaciones((prev) => prev.filter((item) => item.id !== id));
      }
      showSuccess('Autorización desactivada.');
    } catch (err) {
      showError(err.message || 'Error al desactivar autorización');
    }
  };

  const handleSaveCitacionesBridge = async (e) => {
    e.preventDefault();
    await runAction('saveCitacionesBridge', async () => {
      try {
        const data = await apiFetch('/admin/citaciones-bridge', {
          method: 'PUT',
          token: authToken,
          body: {
            enabled: citacionesBridgeConfig.enabled,
            bridgeSecret: citacionesBridgeConfig.bridgeSecret,
            watchFolderHint: citacionesBridgeConfig.watchFolderHint
          }
        });
        setCitacionesBridgeConfig((prev) => ({ ...prev, ...(data.config || {}) }));
        showSuccess('Puente de carpeta de citaciones guardado.');
      } catch (err) {
        showError(err.message || 'Error al guardar puente de citaciones');
      }
    });
  };

  const handleGenerateCitacionesBridgeSecret = () => {
    const bytes = new Uint8Array(18);
    window.crypto.getRandomValues(bytes);
    const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    setCitacionesBridgeConfig((prev) => ({ ...prev, bridgeSecret: secret }));
  };

  const handleRelinkCitacionesNomina = async () => {
    await runAction('relinkCitacionesNomina', async () => {
      try {
        const data = await apiFetch('/admin/citaciones/relink-nomina', {
          method: 'POST',
          token: authToken,
          body: { date: citacionesFilterDate || newCitacionDate }
        });
        showSuccess(data.message || `${data.linked || 0} citación(es) vinculada(s)`);
      } catch (err) {
        showError(err.message || 'No se pudo vincular citaciones con nómina');
      }
    });
  };

  const handleReprocessCitacionesImport = async (importId) => {
    await runAction(`reprocess-import-${importId}`, async () => {
      try {
        const data = await apiFetch(`/admin/citaciones-imports/${importId}/reprocess`, {
          method: 'POST',
          token: authToken,
          body: { force: true }
        });
        showSuccess(data.message || 'Importación reprocesada');
        const importsData = await apiFetch('/admin/citaciones-imports?limit=100', { token: authToken, allowForbidden: true });
        setCitacionesImports(importsData.imports || []);
      } catch (err) {
        showError(err.message || 'No se pudo reprocesar la importación');
      }
    });
  };

  const handleDownloadImportJson = async (importId, sourceFile) => {
    try {
      const data = await apiFetch(`/admin/citaciones-imports/${importId}`, { token: authToken });
      const blob = new Blob([JSON.stringify(data.import, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sourceFile || 'citaciones'}-${importId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError(err.message || 'No se pudo descargar el JSON');
    }
  };

  const filteredCitaciones = citaciones.filter((item) => {
    if (citacionesFilterDate && item.startDate !== citacionesFilterDate) return false;
    if (citacionesFilterFile && item.importSource !== citacionesFilterFile) return false;
    if (citacionesSearch.trim()) {
      const q = citacionesSearch.trim().toLowerCase();
      const nameMatch = (item.name || '').toLowerCase().includes(q);
      const legajoMatch = String(item.legajo || '').includes(q);
      if (!nameMatch && !legajoMatch) return false;
    }
    return true;
  });

  const filteredAutorizados = autorizados.filter((item) => {
    const type = item.type === 'visit' ? 'visita' : item.type;
    if (autorizadosTypeFilter && type !== autorizadosTypeFilter) return false;
    if (autorizadosSearch.trim()) {
      const q = autorizadosSearch.trim().toLowerCase();
      const hay = `${item.name || ''} ${item.legajo || ''} ${item.idNumber || ''} ${item.company || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const handleFileChange = (e) => {
    setSelectedCitacionesFile(e.target.files[0]);
  };

  const handleUploadCitaciones = async () => {
    const fileToUpload = selectedCitacionesFile;
    if (!fileToUpload) {
      setError('Por favor, seleccione un archivo para subir.');
      return;
    }

    setError(null);
    setPendingAction('upload-citaciones');

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(worksheet);

        const result = await apiFetch('/admin/citaciones/sync-upload', {
          method: 'POST',
          token: authToken,
          body: {
            data: json,
            sourceFile: fileToUpload.name,
            force: true
          }
        });
        showSuccess(result.message || 'Planilla de transporte cargada.');
        try {
          const citacionesData = await apiFetch(
            `/admin/authorizations?date=${newCitacionDate}&type=citacion`,
            { token: authToken, allowForbidden: true }
          );
          setCitaciones(citacionesData.authorizations || []);
        } catch { /* ignore */ }
        try {
          const importsData = await apiFetch('/admin/citaciones-imports?limit=100', { token: authToken, allowForbidden: true });
          setCitacionesImports(importsData.imports || []);
        } catch { /* ignore */ }
        setSelectedCitacionesFile(null);
      } catch (err) {
        console.error('Error al procesar archivo de citaciones:', err);
        setError(err.message || 'Error al procesar el archivo. Formato esperado: CSV/XLSX de transporte.');
      } finally {
        setPendingAction(null);
      }
    };
    reader.onerror = () => {
      setPendingAction(null);
      setError('No se pudo leer el archivo seleccionado.');
    };
    reader.readAsArrayBuffer(fileToUpload);
  };

  if (!hasPermission(currentUser, 'master.citaciones.write')) return null;

  const activeTabMeta = AUTH_TABS.find((tab) => tab.id === authTab) || AUTH_TABS[0];

  return (
    <div className="admin-sub-section admin-auth-section">
      <div className="admin-inner-tabs" role="tablist" aria-label="Secciones de autorizaciones">
        {AUTH_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={authTab === tab.id}
              className={`admin-inner-tab ${authTab === tab.id ? 'active' : ''}`}
              onClick={() => setAuthTab(tab.id)}
            >
              <Icon size={16} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <p className="admin-inner-tab-hint">{activeTabMeta.hint}</p>

      {loading && (
        <div className="admin-section-loading">
          <Loader2 className="animate-spin" size={32} />
          <span>Cargando sección…</span>
        </div>
      )}

      {authTab === 'transporte' && (
        <div className="admin-auth-panel">
          <section className="admin-auth-block">
            <div className="admin-auth-block-head">
              <h4>Importación automática (puente)</h4>
              <p>La web no lee el disco C. El puente local vigila la carpeta de planillas y sincroniza los citados.</p>
            </div>

            <form onSubmit={handleSaveCitacionesBridge} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-4">
              <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
                <input
                  type="checkbox"
                  checked={citacionesBridgeConfig.enabled}
                  onChange={(e) => setCitacionesBridgeConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                />
                Habilitar puente de carpeta de citaciones
              </label>
              <div>
                <label className="block text-sm font-medium mb-1">Carpeta a vigilar (referencia)</label>
                <input
                  type="text"
                  value={citacionesBridgeConfig.watchFolderHint || ''}
                  onChange={(e) => setCitacionesBridgeConfig((prev) => ({ ...prev, watchFolderHint: e.target.value }))}
                  className="input-field"
                  placeholder="C:\usr"
                />
                <p className="text-xs text-gray-500 mt-1">Debe coincidir con watchFolder en citaciones-bridge.config.json</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Secreto del puente</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={citacionesBridgeConfig.bridgeSecret || ''}
                    onChange={(e) => setCitacionesBridgeConfig((prev) => ({ ...prev, bridgeSecret: e.target.value }))}
                    className="input-field flex-1"
                    placeholder="Generar y copiar al config local"
                    autoComplete="off"
                  />
                  <button type="button" className="btn btn-secondary-small whitespace-nowrap" onClick={handleGenerateCitacionesBridgeSecret}>
                    Generar
                  </button>
                </div>
              </div>
              <div className="flex items-end">
                <PendingButton
                  type="submit"
                  actionId="saveCitacionesBridge"
                  pendingAction={pendingAction}
                  className="btn btn-primary w-full"
                  pendingLabel="Guardando..."
                >
                  Guardar puente
                </PendingButton>
              </div>
            </form>

            <div className="admin-auth-sync-grid">
              <p><strong>Última sync:</strong> {citacionesBridgeConfig.lastSyncAt ? new Date(citacionesBridgeConfig.lastSyncAt).toLocaleString('es-AR') : '—'}</p>
              <p><strong>Archivo:</strong> {citacionesBridgeConfig.lastSyncFile || '—'}</p>
              <p><strong>Registros:</strong> {citacionesBridgeConfig.lastSyncCount ?? 0}</p>
              {citacionesBridgeConfig.lastSyncError && (
                <p className="text-red-600 md:col-span-3"><strong>Último error:</strong> {citacionesBridgeConfig.lastSyncError}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 mt-4">
              <PendingButton
                type="button"
                actionId="relinkCitacionesNomina"
                pendingAction={pendingAction}
                className="btn btn-secondary"
                pendingLabel="Vinculando..."
                onClick={handleRelinkCitacionesNomina}
              >
                Vincular citados con nómina (hoy)
              </PendingButton>
            </div>
          </section>

          <section className="admin-auth-block">
            <div className="admin-auth-block-head">
              <h4>Carga de planilla (Excel / CSV)</h4>
              <p>Formato transporte: per__cod, per__des, sector__des, diacitacioningreso. Mismo formato que el puente.</p>
            </div>
            <input
              type="file"
              id="uploadCitaciones"
              accept=".csv, .xlsx"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100"
            />
            <PendingButton
              type="button"
              actionId="upload-citaciones"
              pendingAction={pendingAction}
              className="btn btn-secondary mt-2"
              disabled={!selectedCitacionesFile}
              pendingLabel="Subiendo archivo..."
              onClick={handleUploadCitaciones}
            >
              <Upload size={18} /> Cargar planilla de transporte
            </PendingButton>
          </section>

          {citacionesImports.length > 0 && (
            <section className="admin-auth-block">
              <div className="admin-auth-block-head">
                <h4>Planificaciones importadas ({citacionesImports.length})</h4>
                <p>Historial de planillas. Cada import se guarda; no pisa el anterior.</p>
              </div>
              <div className="scroll-panel-max overflow-x-auto border border-gray-200 rounded-md">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs uppercase">Importado</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">Archivo</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">Días citados</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">Personas</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">JSON</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {citacionesImports.map((batch) => (
                      <tr key={batch.id} className="border-t">
                        <td className="px-3 py-2">{batch.importedAt ? new Date(batch.importedAt).toLocaleString('es-AR') : '—'}</td>
                        <td className="px-3 py-2">{batch.sourceFile || '—'}</td>
                        <td className="px-3 py-2">{(batch.citacionDates || []).join(', ') || '—'}</td>
                        <td className="px-3 py-2">{batch.rowCount}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            className="btn btn-secondary-small"
                            onClick={() => handleDownloadImportJson(batch.id, batch.sourceFile)}
                          >
                            Descargar
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <PendingButton
                            type="button"
                            actionId={`reprocess-import-${batch.id}`}
                            pendingAction={pendingAction}
                            className="btn btn-secondary-small"
                            pendingLabel="..."
                            onClick={() => handleReprocessCitacionesImport(batch.id)}
                          >
                            Reprocesar
                          </PendingButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="admin-auth-block">
            <div className="admin-auth-block-head">
              <h4>Personas citadas (transporte)</h4>
              <p>
                {citacionesViewMode === 'planned'
                  ? 'Citaciones planificadas en los próximos días.'
                  : citacionesViewMode === 'range'
                    ? 'Citaciones entre dos fechas.'
                    : 'Citaciones de un solo día.'}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-3">
              <select
                value={citacionesViewMode}
                onChange={(e) => setCitacionesViewMode(e.target.value)}
                className="input-field bg-white"
              >
                <option value="planned">Próximos días planificados</option>
                <option value="day">Un día</option>
                <option value="range">Rango de fechas</option>
              </select>
              {citacionesViewMode === 'day' && (
                <input
                  type="date"
                  value={citacionesViewDate}
                  onChange={(e) => setCitacionesViewDate(e.target.value)}
                  className="input-field"
                />
              )}
              {citacionesViewMode !== 'day' && (
                <>
                  <input
                    type="date"
                    value={citacionesRangeFrom}
                    onChange={(e) => setCitacionesRangeFrom(e.target.value)}
                    className="input-field"
                    title="Desde"
                  />
                  {citacionesViewMode === 'range' && (
                    <input
                      type="date"
                      value={citacionesRangeTo}
                      onChange={(e) => setCitacionesRangeTo(e.target.value)}
                      className="input-field"
                      title="Hasta"
                    />
                  )}
                </>
              )}
            </div>

            {plannedDates.length > 0 && (
              <div className="flex flex-wrap gap-2 items-center mb-3">
                <span className="text-sm text-gray-600">Días con citaciones:</span>
                <button
                  type="button"
                  className="btn btn-secondary-small"
                  onClick={() => setCitacionesFilterDate('')}
                >
                  Todos ({citaciones.length})
                </button>
                {plannedDates.map(({ date, count }) => (
                  <button
                    key={date}
                    type="button"
                    className={`btn btn-secondary-small ${citacionesFilterDate === date ? 'ring-2 ring-red-500' : ''}`}
                    onClick={() => setCitacionesFilterDate(citacionesFilterDate === date ? '' : date)}
                  >
                    {date.split('-').reverse().join('/')} ({count})
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
              <input
                type="text"
                value={citacionesSearch}
                onChange={(e) => setCitacionesSearch(e.target.value)}
                className="input-field"
                placeholder="Buscar por nombre o legajo"
              />
              <select
                value={citacionesFilterFile}
                onChange={(e) => setCitacionesFilterFile(e.target.value)}
                className="input-field bg-white"
              >
                <option value="">Todas las planillas</option>
                {[...new Set(citacionesImports.map((b) => b.sourceFile).filter(Boolean))].map((file) => (
                  <option key={file} value={file}>{file}</option>
                ))}
              </select>
              <p className="text-sm text-gray-600 self-center">
                Mostrando {filteredCitaciones.length} de {citaciones.length}
              </p>
            </div>

            {filteredCitaciones.length === 0 ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                No hay citados de transporte con los filtros actuales.
              </p>
            ) : (
              <div className="scroll-panel-max overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs uppercase">Día</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Nombre</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Legajo</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Planilla</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Destino</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Rol</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCitaciones.map((item) => (
                      <tr key={item.id} className="border-t">
                        <td className="px-4 py-2 text-sm">{formatAuthSchedule(item)}</td>
                        <td className="px-4 py-2">{item.name}</td>
                        <td className="px-4 py-2">{item.legajo || '—'}</td>
                        <td className="px-4 py-2 text-xs">{item.importSource || '—'}</td>
                        <td className="px-4 py-2">{item.destination || item.company || '—'}</td>
                        <td className="px-4 py-2 text-sm">{item.role || '—'}</td>
                        <td className="px-4 py-2">
                          <button type="button" className="btn btn-danger-small" onClick={() => handleDeleteCitacion(item.id, 'citaciones')}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <details className="admin-auth-help">
            <summary>Instalación del puente en la PC de transporte</summary>
            <ol className="list-decimal list-inside space-y-1 mt-2 text-xs text-gray-500">
              <li>Ejecutar <code>install-citaciones-bridge.cmd</code></li>
              <li>Editar <code>citaciones-bridge.config.json</code> (carpeta, apiBaseUrl, bridgeSecret)</li>
              <li>Ejecutar <code>node citaciones-folder-bridge.js</code> o PM2</li>
              <li>Cada planilla nueva (.xlsx/.xls/.csv) se importa sola</li>
            </ol>
          </details>
        </div>
      )}

      {authTab === 'manual' && (
        <div className="admin-auth-panel">
          <section className="admin-auth-block">
            <div className="admin-auth-block-head">
              <h4>Nueva autorización manual</h4>
              <p>
                Para visitas, contratistas u accesos fijos. Las planillas de transporte van en la pestaña
                {' '}<strong>Citados transporte</strong>.
              </p>
            </div>

            <form onSubmit={handleCreateCitacion} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <select value={newAuthType} onChange={(e) => setNewAuthType(e.target.value)} className="input-field bg-white">
                  <option value="visita">Visita (rango de fechas)</option>
                  <option value="temporal">Temporal (contratista / obra)</option>
                  <option value="permanent">Permanente (turno / acceso fijo)</option>
                  <option value="citacion">Citación puntual (un día)</option>
                </select>
                <select value={newAuthPersonTipo} onChange={(e) => setNewAuthPersonTipo(e.target.value)} className="input-field bg-white">
                  <option value="visita">Visita externa</option>
                  <option value="tercero">Tercerizado</option>
                  <option value="cliente">Cliente</option>
                  <option value="empleado">Empleado</option>
                </select>
                <input type="text" value={newCitacionName} onChange={(e) => setNewCitacionName(e.target.value)} className="input-field" placeholder="Apellido y nombre" required />
                <input type="text" value={newCitacionDni} onChange={(e) => setNewCitacionDni(e.target.value)} className="input-field" placeholder="DNI" />
                <input type="text" value={newCitacionLegajo} onChange={(e) => setNewCitacionLegajo(e.target.value)} className="input-field" placeholder="Legajo (si no hay DNI)" />
                <input type="text" value={newCitacionCompany} onChange={(e) => setNewCitacionCompany(e.target.value)} className="input-field" placeholder="Empresa" />
                <input type="text" value={newCitacionDestination} onChange={(e) => setNewCitacionDestination(e.target.value)} className="input-field" placeholder="Destino / sector" />
                {newAuthType === 'citacion' && (
                  <input type="date" value={newCitacionDate} onChange={(e) => setNewCitacionDate(e.target.value)} className="input-field" required />
                )}
                {(newAuthType === 'visita' || newAuthType === 'temporal') && (
                  <>
                    <input type="date" value={newAuthStartDate} onChange={(e) => setNewAuthStartDate(e.target.value)} className="input-field" required title="Desde" />
                    <input type="date" value={newAuthEndDate} onChange={(e) => setNewAuthEndDate(e.target.value)} className="input-field" required title="Hasta" />
                  </>
                )}
                {newAuthType === 'permanent' && (
                  <>
                    <input type="date" value={newAuthStartDate} onChange={(e) => setNewAuthStartDate(e.target.value)} className="input-field" title="Vigencia desde (opcional)" />
                    <input type="time" value={newAuthTimeFrom} onChange={(e) => setNewAuthTimeFrom(e.target.value)} className="input-field" title="Horario desde" />
                    <input type="time" value={newAuthTimeTo} onChange={(e) => setNewAuthTimeTo(e.target.value)} className="input-field" title="Horario hasta" />
                  </>
                )}
                <input type="text" value={newAuthNotes} onChange={(e) => setNewAuthNotes(e.target.value)} className="input-field xl:col-span-2" placeholder="Observaciones (opcional)" />
              </div>
              {newAuthType === 'permanent' && (
                <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                  <p className="text-sm font-medium mb-2">Días habilitados (vacío = todos los días)</p>
                  <div className="flex flex-wrap gap-2">
                    {AUTH_WEEKDAYS.map(({ code, label }) => (
                      <label key={code} className="inline-flex items-center gap-1 text-sm bg-white border rounded px-2 py-1">
                        <input
                          type="checkbox"
                          checked={newAuthDaysOfWeek.includes(code)}
                          onChange={() => toggleAuthDay(code)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <PendingButton type="submit" actionId="createCitacion" pendingAction={pendingAction} className="btn btn-primary" pendingLabel="Agregando...">
                <PlusCircle size={18} /> Agregar autorización
              </PendingButton>
            </form>
          </section>
        </div>
      )}

      {authTab === 'listado' && (
        <div className="admin-auth-panel">
          <section className="admin-auth-block">
            <div className="admin-auth-block-head">
              <h4>Autorizados vigentes</h4>
              <p>Visitas, temporales y permanentes. Los citados de planilla de transporte están en la otra pestaña.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
              <input
                type="date"
                value={autorizadosDate}
                onChange={(e) => setAutorizadosDate(e.target.value)}
                className="input-field"
                title="Fecha de vigencia"
              />
              <select
                value={autorizadosTypeFilter}
                onChange={(e) => setAutorizadosTypeFilter(e.target.value)}
                className="input-field bg-white"
              >
                <option value="">Todos los tipos</option>
                <option value="visita">Visitas</option>
                <option value="temporal">Temporales</option>
                <option value="permanent">Permanentes</option>
              </select>
              <input
                type="text"
                value={autorizadosSearch}
                onChange={(e) => setAutorizadosSearch(e.target.value)}
                className="input-field"
                placeholder="Buscar nombre, DNI, empresa…"
              />
            </div>

            <p className="text-sm text-gray-600 mb-3">
              Mostrando {filteredAutorizados.length} de {autorizados.length}
            </p>

            {filteredAutorizados.length === 0 ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                No hay autorizados (visitas / temporales / permanentes) para esta fecha.
                Usá <strong>Carga manual</strong> para dar de alta uno.
              </p>
            ) : (
              <div className="scroll-panel-max overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs uppercase">Tipo</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Vigencia</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Nombre</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">DNI</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Empresa</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Destino</th>
                      <th className="px-4 py-2 text-left text-xs uppercase">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAutorizados.map((item) => (
                      <tr key={item.id} className="border-t">
                        <td className="px-4 py-2">
                          <span className={`auth-type-badge ${(item.type === 'visit' ? 'visita' : item.type) || 'visita'}`}>
                            {AUTH_TYPE_LABELS[item.type] || item.type}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-sm">{formatAuthSchedule(item)}</td>
                        <td className="px-4 py-2">{item.name}</td>
                        <td className="px-4 py-2">{item.idNumber || '—'}</td>
                        <td className="px-4 py-2">{item.company || '—'}</td>
                        <td className="px-4 py-2">{item.destination || '—'}</td>
                        <td className="px-4 py-2">
                          <button type="button" className="btn btn-danger-small" onClick={() => handleDeleteCitacion(item.id, 'autorizados')}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default CitacionesAdminSection;
