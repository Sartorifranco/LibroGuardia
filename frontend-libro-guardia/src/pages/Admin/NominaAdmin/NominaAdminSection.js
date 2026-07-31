import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import {
  ClipboardList,
  Download,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X
} from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import {
  AdminBlock,
  AdminEmpty,
  AdminLoading,
  AdminTable
} from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';
import { parseTurnoPreview } from '../../../utils/parseTurnoPreview';

const AUTH_POLICY_OPTIONS = [
  { value: 'permanent_shift', label: 'Permanente dentro del turno' },
  { value: 'permanent', label: 'Permanente' },
  { value: 'citacion_shift', label: 'Ajustar citación (turno)' },
  { value: 'citacion', label: 'Con citación' },
  { value: 'previa', label: 'Autorización previa' }
];

const POLICY_EXPORT_LABEL = {
  permanent_shift: 'PERMANENTE dentro del turno',
  permanent: 'PERMANENTE',
  citacion_shift: 'Ajustar citación',
  citacion: 'Con citación',
  previa: 'Autorización previa',
  unknown: ''
};

const emptyForm = () => ({
  name: '',
  idNumber: '',
  legajo: '',
  role: '',
  area: '',
  centroCosto: '',
  email: '',
  phone: '',
  cuil: '',
  birthDate: '',
  sex: '',
  turnoRaw: 'Lu,Ma,Mi,Ju,Vi,Sa,Do 08:00 a 17:00',
  requiresCitacion: false,
  authorizationPolicy: 'permanent_shift',
  active: true
});

const policyLabel = (code) => (
  AUTH_POLICY_OPTIONS.find((opt) => opt.value === code)?.label || code || '—'
);

const toExportRow = (emp) => ({
  Usuario: emp.name || '',
  DNI: emp.idNumberNormalized || emp.idNumber || '',
  Legajo: emp.legajoNormalized || emp.legajo || '',
  Rol: emp.role || '',
  'C. Costo': emp.centroCosto || '',
  Turno: emp.turnoRaw || '',
  'Con citacion': emp.requiresCitacion ? 'SI' : 'NO',
  'Tipo de autorizacion': POLICY_EXPORT_LABEL[emp.authorizationPolicy] || emp.authorizationPolicy || ''
});

const downloadNominaXlsx = (rows, filename) => {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Nomina');
  XLSX.writeFile(workbook, filename);
};

/**
 * Sección "Nómina" del panel de administración.
 * @param {{ pendingAction: string|null, setPendingAction: Function, runAction?: Function }} props
 */
function NominaAdminSection({ pendingAction, setPendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError, setError } = useToast();
  const { confirm } = useConfirm();

  const canWrite = hasPermission(currentUser, 'master.nomina.write');
  const canRead = hasPermission(currentUser, 'master.nomina.read');

  const [loading, setLoading] = useState(true);
  const [selectedNominaFile, setSelectedNominaFile] = useState(null);
  const [replaceOnImport, setReplaceOnImport] = useState(true);
  const [nominaData, setNominaData] = useState([]);
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const run = async (actionId, fn) => {
    if (typeof runAction === 'function') {
      await runAction(actionId, fn);
      return;
    }
    setPendingAction?.(actionId);
    try {
      await fn();
    } finally {
      setPendingAction?.(null);
    }
  };

  const refreshList = async () => {
    const data = await apiFetch('/admin/nomina', { token: authToken, allowForbidden: true });
    setNominaData(data.personal || []);
  };

  useEffect(() => {
    if (!currentUser || !canRead) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await apiFetch('/admin/nomina', { token: authToken, allowForbidden: true });
        if (!cancelled) setNominaData(data.personal || []);
      } catch (err) {
        if (!cancelled) showError(err.message || 'Error al cargar nómina');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser, authToken, canRead, showError]);

  const stats = useMemo(() => {
    const active = nominaData.filter((e) => e.active !== false).length;
    return {
      total: nominaData.length,
      active,
      inactive: Math.max(0, nominaData.length - active)
    };
  }, [nominaData]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nominaData.filter((emp) => {
      if (!showInactive && emp.active === false) return false;
      if (!q) return true;
      return [
        emp.name,
        emp.idNumberNormalized || emp.idNumber,
        emp.legajoNormalized || emp.legajo,
        emp.role,
        emp.centroCosto,
        emp.turnoRaw,
        emp.authorizationPolicy
      ].join(' ').toLowerCase().includes(q);
    });
  }, [nominaData, query, showInactive]);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(false);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
  };

  const openEdit = (emp) => {
    setEditingId(emp.id);
    setForm({
      name: emp.name || '',
      idNumber: emp.idNumberNormalized || emp.idNumber || '',
      legajo: emp.legajoNormalized || emp.legajo || '',
      role: emp.puesto || emp.role || '',
      area: emp.area || '',
      centroCosto: emp.centroCosto || '',
      email: emp.email || '',
      phone: emp.phone || '',
      cuil: emp.cuil || '',
      birthDate: emp.birthDate || '',
      sex: emp.sex || '',
      turnoRaw: emp.turnoRaw || 'Lu,Ma,Mi,Ju,Vi,Sa,Do 08:00 a 17:00',
      requiresCitacion: emp.requiresCitacion === true,
      authorizationPolicy: emp.authorizationPolicy || 'permanent_shift',
      active: emp.active !== false
    });
    setFormOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canWrite) return;
    await run(editingId ? `update-nomina-${editingId}` : 'create-nomina', async () => {
      try {
        const body = {
          name: form.name.trim(),
          idNumber: form.idNumber.trim(),
          legajo: form.legajo.trim(),
          role: form.role.trim(),
          puesto: form.role.trim(),
          area: form.area.trim(),
          centroCosto: form.centroCosto.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          cuil: form.cuil.trim(),
          birthDate: form.birthDate.trim(),
          sex: form.sex.trim(),
          turnoRaw: form.turnoRaw.trim(),
          requiresCitacion: form.requiresCitacion,
          authorizationPolicy: form.authorizationPolicy,
          active: form.active !== false
        };
        if (editingId) {
          await apiFetch(`/admin/nomina/${editingId}`, {
            method: 'PUT',
            token: authToken,
            body
          });
          showSuccess('Empleado actualizado');
        } else {
          await apiFetch('/admin/nomina', {
            method: 'POST',
            token: authToken,
            body
          });
          showSuccess('Empleado agregado a la nómina');
        }
        resetForm();
        await refreshList();
      } catch (err) {
        showError(err.message || 'No se pudo guardar el empleado');
      }
    });
  };

  const handleDeactivate = async (emp) => {
    const ok = await confirm({
      title: 'Dar de baja',
      message: `¿Dar de baja a “${emp.name}” de la nómina? Queda inactivo (no se borra el historial).`,
      confirmLabel: 'Dar de baja',
      tone: 'danger'
    });
    if (!ok) return;
    await run(`del-nomina-${emp.id}`, async () => {
      try {
        await apiFetch(`/admin/nomina/${emp.id}`, { method: 'DELETE', token: authToken });
        showSuccess('Empleado dado de baja');
        if (editingId === emp.id) resetForm();
        await refreshList();
      } catch (err) {
        showError(err.message || 'No se pudo dar de baja');
      }
    });
  };

  const handleFileChange = (e) => {
    setSelectedNominaFile(e.target.files[0]);
  };

  const parseNominaWorksheet = (worksheet) => {
    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
    const headerIndex = matrix.findIndex((row) => {
      const cells = row.map((cell) => String(cell || '').toLowerCase());
      const hasDni = cells.some((c) => c.includes('dni'));
      const hasClassic = cells.some((c) => c.includes('usuario'));
      const hasLegajos = cells.some((c) => c.includes('apellido'))
        && cells.some((c) => c === 'nombre' || c.includes('nombre'));
      return hasDni && (hasClassic || hasLegajos);
    });
    if (headerIndex < 0) {
      throw new Error('No se encontraron encabezados (Usuario/DNI o Apellido/Nombre/DNI) en la planilla');
    }
    const headers = matrix[headerIndex].map((header) => String(header || '').trim());
    const rowMeta = worksheet['!rows'] || [];
    // Excel 1-based: title rows + headerIndex (0-based in matrix) → data starts at headerIndex+2
    const excelHeaderRow = headerIndex + 1; // 1-based if matrix[0] is Excel row 1

    return matrix
      .slice(headerIndex + 1)
      .map((row, offset) => {
        const excelRowNumber = excelHeaderRow + 1 + offset; // 1-based
        const meta = rowMeta[excelRowNumber - 1];
        const hidden = meta && meta.hidden === true;
        return { row, hidden, excelRowNumber };
      })
      .filter(({ row, hidden }) => !hidden && row.some((cell) => String(cell ?? '').trim()))
      .map(({ row }) => {
        const item = {};
        headers.forEach((header, index) => {
          if (header) item[header] = row[index];
        });
        return item;
      });
  };

  const handleUploadNomina = async () => {
    if (!selectedNominaFile) {
      setError('Seleccione el archivo de nómina.');
      return;
    }
    if (replaceOnImport) {
      const ok = await confirm({
        title: 'Reemplazar nómina',
        message: 'Se importarán solo las filas visibles del Excel y se dará de baja la nómina anterior que no esté en el archivo. No se toca BioStar (huellas). ¿Continuar?',
        confirmLabel: 'Reemplazar e importar'
      });
      if (!ok) return;
    }
    await run('upload-nomina', async () => {
      const buffer = await selectedNominaFile.arrayBuffer();
      try {
        const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const parsedData = parseNominaWorksheet(worksheet).map((row) => {
          const cleaned = { ...row };
          Object.entries(cleaned).forEach(([key, value]) => {
            if (/tipo.*autoriz/i.test(key) && String(value).length > 120) {
              cleaned[key] = String(value).slice(0, 120);
            }
          });
          return cleaned;
        });
        if (!parsedData.length) {
          setError('No hay filas visibles para importar (¿filtro de Excel vacío?)');
          return;
        }
        const result = await apiFetch('/admin/nomina/upload', {
          method: 'POST',
          token: authToken,
          body: { data: parsedData, replace: replaceOnImport }
        });
        if ((result.imported ?? 0) === 0 && (result.total ?? 0) > 0) {
          const sample = (result.errors || []).slice(0, 3).map((e) => `${e.name}: ${e.reason}`).join(' · ');
          setError(result.message || `Ningún empleado importado${sample ? ` (${sample})` : ''}`);
        } else {
          showSuccess(result.message || 'Nómina importada');
        }
        setSelectedNominaFile(null);
        await refreshList();
      } catch (err) {
        setError(err.message || 'Error al procesar nómina');
      }
    });
  };

  const handleExportNomina = () => {
    const source = filtered.length ? filtered : nominaData.filter((e) => e.active !== false);
    if (!source.length) {
      showError('No hay empleados para exportar.');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadNominaXlsx(
      source.map(toExportRow),
      `nomina-${stamp}.xlsx`
    );
    showSuccess(`Nómina exportada (${source.length} empleados).`);
  };

  if (!canWrite && !canRead) return null;
  if (!canWrite) {
    return <p className="theme-section-desc">Sin permiso master.nomina.write para gestionar la nómina.</p>;
  }

  return (
    <div className="nomina-admin">
      <div className="nomina-admin__stats" aria-label="Resumen de nómina">
        <div className="nomina-admin__stat">
          <span className="nomina-admin__stat-label">Total</span>
          <strong className="nomina-admin__stat-value">{stats.total}</strong>
        </div>
        <div className="nomina-admin__stat nomina-admin__stat--ok">
          <span className="nomina-admin__stat-label">Activos</span>
          <strong className="nomina-admin__stat-value">{stats.active}</strong>
        </div>
        <div className="nomina-admin__stat">
          <span className="nomina-admin__stat-label">Inactivos</span>
          <strong className="nomina-admin__stat-value">{stats.inactive}</strong>
        </div>
      </div>

      <AdminBlock
        title="Importar / exportar nómina"
        description="Soporta Legajos Online (Apellido, Nombre, DNI, CUIL, Áreas, Puestos…) y el formato clásico. Solo importa filas visibles del Excel. Con “Reemplazar” da de baja la nómina vieja; no toca BioStar."
      >
        <div className="nomina-admin__import">
          <label className="nomina-admin__field">
            <span>Archivo XLSX</span>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="input-field"
            />
          </label>
          <label className="nomina-admin__check" style={{ alignSelf: 'end', marginBottom: '0.5rem' }}>
            <input
              type="checkbox"
              checked={replaceOnImport}
              onChange={(e) => setReplaceOnImport(e.target.checked)}
            />
            Reemplazar nómina anterior (recomendado)
          </label>
          <div className="nomina-admin__import-actions">
            <PendingButton
              type="button"
              actionId="upload-nomina"
              pendingAction={pendingAction}
              className="btn btn-primary"
              disabled={!selectedNominaFile}
              pendingLabel="Importando…"
              onClick={handleUploadNomina}
            >
              <Upload size={16} />
              Importar nómina
            </PendingButton>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleExportNomina}
              disabled={loading || (!filtered.length && !nominaData.length)}
            >
              <Download size={16} />
              Exportar Excel
            </button>
          </div>
        </div>
      </AdminBlock>

      <AdminBlock
        title={`Empleados (${filtered.length}${query || showInactive ? ` / ${stats.total}` : ''})`}
        description="Alta y edición individual. La baja deja el registro inactivo."
        action={(
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} />
            Agregar empleado
          </button>
        )}
      >
        <div className="nomina-admin__toolbar">
          <label className="nomina-admin__search">
            <span className="sr-only">Buscar empleado</span>
            <input
              className="input-field"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre, DNI, legajo, rol o c. costo…"
            />
          </label>
          <label className="nomina-admin__check">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Mostrar inactivos
          </label>
        </div>

        {loading ? (
          <AdminLoading label="Cargando nómina…" />
        ) : filtered.length === 0 ? (
          <AdminEmpty
            icon={ClipboardList}
            title={nominaData.length === 0 ? 'Sin empleados' : 'Sin resultados'}
            description={
              nominaData.length === 0
                ? 'Importá la planilla o agregá un empleado manualmente.'
                : 'Probá otro término o incluí inactivos.'
            }
          />
        ) : (
          <AdminTable className="nomina-admin__table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>DNI</th>
                <th>Legajo</th>
                <th>Puesto</th>
                <th>Área</th>
                <th>Sexo</th>
                <th>Email</th>
                <th>Tel.</th>
                <th>Turno</th>
                <th>Citación</th>
                <th className="nomina-admin__th-actions">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((emp) => (
                <tr key={emp.id || emp.legajoNormalized || emp.idNumberNormalized} className={emp.active === false ? 'nomina-admin__row--off' : ''}>
                  <td>
                    <div className="nomina-admin__name-cell">
                      <span>{emp.name}</span>
                      {emp.cuil ? <span className="historial-meta">CUIL {emp.cuil}</span> : null}
                      {emp.active === false && <span className="nomina-admin__chip">Inactivo</span>}
                    </div>
                  </td>
                  <td>{emp.idNumberNormalized || emp.idNumber || '—'}</td>
                  <td>{emp.legajoNormalized || emp.legajo || '—'}</td>
                  <td>{emp.puesto || emp.role || '—'}</td>
                  <td>{emp.area || '—'}</td>
                  <td>{emp.sex || '—'}</td>
                  <td>{emp.email || '—'}</td>
                  <td>{emp.phone || '—'}</td>
                  <td className="nomina-admin__turno">{emp.turnoRaw || '—'}</td>
                  <td>{emp.requiresCitacion ? 'Sí' : 'No'}</td>
                  <td>
                    <div className="nomina-admin__actions">
                      <button
                        type="button"
                        className="nomina-admin__icon-btn"
                        title="Editar"
                        aria-label={`Editar ${emp.name}`}
                        onClick={() => openEdit(emp)}
                      >
                        <Pencil size={15} />
                      </button>
                      {emp.active !== false && (
                        <button
                          type="button"
                          className="nomina-admin__icon-btn nomina-admin__icon-btn--danger"
                          title="Dar de baja"
                          aria-label={`Dar de baja a ${emp.name}`}
                          onClick={() => handleDeactivate(emp)}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminBlock>

      {formOpen && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onClick={resetForm}>
          <div
            className="admin-modal admin-modal--wide nomina-admin__modal"
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? 'Editar empleado' : 'Agregar empleado'}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="nomina-admin__modal-head">
              <div>
                <h3 className="admin-modal-title">
                  {editingId ? 'Editar empleado' : 'Agregar empleado'}
                </h3>
                <p className="theme-section-desc">
                  Se sincroniza con la ficha de persona y, si corresponde, con la autorización permanente.
                </p>
              </div>
              <button type="button" className="nomina-admin__icon-btn" onClick={resetForm} aria-label="Cerrar">
                <X size={16} />
              </button>
            </header>

            <form onSubmit={handleSubmit} className="nomina-admin__form">
              <label className="nomina-admin__field">
                <span>Nombre</span>
                <input
                  className="input-field"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  autoFocus
                />
              </label>
              <div className="nomina-admin__form-row">
                <label className="nomina-admin__field">
                  <span>DNI</span>
                  <input
                    className="input-field"
                    value={form.idNumber}
                    onChange={(e) => setForm((f) => ({ ...f, idNumber: e.target.value }))}
                  />
                </label>
                <label className="nomina-admin__field">
                  <span>Legajo</span>
                  <input
                    className="input-field"
                    value={form.legajo}
                    onChange={(e) => setForm((f) => ({ ...f, legajo: e.target.value }))}
                  />
                </label>
              </div>
              <div className="nomina-admin__form-row">
                <label className="nomina-admin__field">
                  <span>Puesto</span>
                  <input
                    className="input-field"
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                    placeholder="Chofer, Recontador…"
                  />
                </label>
                <label className="nomina-admin__field">
                  <span>Área</span>
                  <input
                    className="input-field"
                    value={form.area}
                    onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))}
                    placeholder="Transporte, Tesorería…"
                  />
                </label>
              </div>
              <div className="nomina-admin__form-row">
                <label className="nomina-admin__field">
                  <span>Centro de costo</span>
                  <input
                    className="input-field"
                    value={form.centroCosto}
                    onChange={(e) => setForm((f) => ({ ...f, centroCosto: e.target.value }))}
                  />
                </label>
                <label className="nomina-admin__field">
                  <span>CUIL</span>
                  <input
                    className="input-field"
                    value={form.cuil}
                    onChange={(e) => setForm((f) => ({ ...f, cuil: e.target.value }))}
                  />
                </label>
              </div>
              <div className="nomina-admin__form-row">
                <label className="nomina-admin__field">
                  <span>Email</span>
                  <input
                    className="input-field"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  />
                </label>
                <label className="nomina-admin__field">
                  <span>Teléfono</span>
                  <input
                    className="input-field"
                    value={form.phone}
                    onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  />
                </label>
              </div>
              <div className="nomina-admin__form-row">
                <label className="nomina-admin__field">
                  <span>Fecha nac. (AAAA-MM-DD)</span>
                  <input
                    className="input-field"
                    value={form.birthDate}
                    onChange={(e) => setForm((f) => ({ ...f, birthDate: e.target.value }))}
                    placeholder="1970-09-29"
                  />
                </label>
                <label className="nomina-admin__field">
                  <span>Sexo</span>
                  <input
                    className="input-field"
                    value={form.sex}
                    onChange={(e) => setForm((f) => ({ ...f, sex: e.target.value }))}
                    placeholder="Masculino / Femenino"
                  />
                </label>
              </div>
              <div className="nomina-admin__turno-block">
                <label className="nomina-admin__field">
                  <span>Turno</span>
                  <input
                    className="input-field"
                    value={form.turnoRaw}
                    onChange={(e) => setForm((f) => ({ ...f, turnoRaw: e.target.value }))}
                    placeholder="Lu,Ma,Mi,Ju,Vi,Sa,Do 08:00 a 17:00"
                  />
                  <small className={`nomina-admin__turno-hint${parseTurnoPreview(form.turnoRaw).valid ? ' is-ok' : ''}`}>
                    {(() => {
                      const preview = parseTurnoPreview(form.turnoRaw);
                      return preview.valid
                        ? `El sistema entiende: ${preview.label}`
                        : preview.label;
                    })()}
                  </small>
                </label>
                <aside className="nomina-admin__turno-help" aria-label="Cómo se interpretan los turnos">
                  <strong>Cómo toma el turno el sistema</strong>
                  <p>
                    No lee el texto libre: busca días
                    {' '}
                    <code>Lu,Ma,Mi,Ju,Vi,Sa,Do</code>
                    {' '}
                    y un horario
                    {' '}
                    <code>HH:MM a HH:MM</code>
                    .
                  </p>
                  <p>
                    Ejemplo válido:
                    {' '}
                    <code>Lu,Ma,Mi,Ju,Vi 07:30 a 16:00</code>
                    .
                    Si la autorización es “dentro del turno”, solo deja pasar esos días y en esa franja
                    (con unos minutos de tolerancia).
                  </p>
                </aside>
              </div>
              <label className="nomina-admin__field">
                <span>Tipo de autorización</span>
                <select
                  className="input-field"
                  value={form.authorizationPolicy}
                  onChange={(e) => setForm((f) => ({ ...f, authorizationPolicy: e.target.value }))}
                >
                  {AUTH_POLICY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <label className="nomina-admin__check">
                <input
                  type="checkbox"
                  checked={form.requiresCitacion}
                  onChange={(e) => setForm((f) => ({ ...f, requiresCitacion: e.target.checked }))}
                />
                Requiere citación
              </label>
              {editingId && (
                <label className="nomina-admin__check">
                  <input
                    type="checkbox"
                    checked={form.active !== false}
                    onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                  />
                  Empleado activo en nómina
                </label>
              )}
              <div className="estaciones-admin__modal-footer">
                <button type="button" className="btn btn-secondary" onClick={resetForm}>
                  Cancelar
                </button>
                <PendingButton
                  type="submit"
                  className="btn btn-primary"
                  actionId={editingId ? `update-nomina-${editingId}` : 'create-nomina'}
                  pendingAction={pendingAction}
                  pendingLabel="Guardando…"
                >
                  {editingId ? 'Guardar cambios' : 'Agregar empleado'}
                </PendingButton>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default NominaAdminSection;
