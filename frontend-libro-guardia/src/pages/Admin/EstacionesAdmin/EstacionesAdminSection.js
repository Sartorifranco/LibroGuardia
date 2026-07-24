import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  Pencil,
  PlusCircle,
  Server,
  Trash2
} from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import {
  AdminBlock,
  AdminEmpty,
  AdminFormCard,
  AdminLoading,
  AdminTable
} from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';

function downloadJson(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const emptyForm = () => ({
  nombre: '',
  direccionRedLocal: '',
  puertoServidorLocal: 8787,
  secretoLocal: '',
  activa: true
});

function EstacionesAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();

  const canManage = hasPermission(currentUser, 'lectores.manage');

  const [loading, setLoading] = useState(true);
  const [estaciones, setEstaciones] = useState([]);
  const [lectores, setLectores] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [selectedLectorIds, setSelectedLectorIds] = useState([]);
  const [assigningId, setAssigningId] = useState(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      const [estData, lecData] = await Promise.all([
        apiFetch('/admin/estaciones', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/lectores', { token: authToken, allowForbidden: true })
      ]);
      setEstaciones(estData.estaciones || []);
      setLectores(lecData.lectores || []);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar las estaciones');
    } finally {
      setLoading(false);
    }
  }, [authToken, canManage, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const lectoresById = useMemo(() => {
    const map = new Map();
    lectores.forEach((l) => map.set(l.id, l));
    return map;
  }, [lectores]);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm());
  };

  const startEdit = (row) => {
    setEditingId(row.id);
    setForm({
      nombre: row.nombre || '',
      direccionRedLocal: row.direccionRedLocal || '',
      puertoServidorLocal: Number(row.puertoServidorLocal) || 8787,
      secretoLocal: row.secretoLocal || '',
      activa: row.activa !== false
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    const body = {
      nombre: form.nombre.trim(),
      direccionRedLocal: form.direccionRedLocal.trim(),
      puertoServidorLocal: Number(form.puertoServidorLocal) || 8787,
      activa: form.activa !== false
    };
    if (form.secretoLocal.trim()) body.secretoLocal = form.secretoLocal.trim();

    await runAction(editingId ? `update-est-${editingId}` : 'create-est', async () => {
      try {
        if (editingId) {
          const data = await apiFetch(`/admin/estaciones/${editingId}`, {
            method: 'PUT',
            token: authToken,
            body
          });
          setEstaciones((prev) => prev.map((x) => (
            x.id === editingId
              ? { ...x, ...data.estacion, lectoresCount: x.lectoresCount, lectorIds: x.lectorIds }
              : x
          )));
          showSuccess('Estación actualizada');
        } else {
          const data = await apiFetch('/admin/estaciones', {
            method: 'POST',
            token: authToken,
            body
          });
          setEstaciones((prev) => [...prev, {
            ...data.estacion,
            lectoresCount: 0,
            lectorIds: []
          }].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es')));
          showSuccess('Estación creada. Descargá el JSON cuando asignes lectores.');
        }
        resetForm();
      } catch (err) {
        showError(err.message || 'Error al guardar estación');
      }
    });
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: 'Eliminar estación',
      message: `¿Eliminar “${row.nombre}”? Los lectores quedan sin estación (siguen activos).`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    await runAction(`del-est-${row.id}`, async () => {
      try {
        await apiFetch(`/admin/estaciones/${row.id}`, { method: 'DELETE', token: authToken });
        setEstaciones((prev) => prev.filter((x) => x.id !== row.id));
        setLectores((prev) => prev.map((l) => (
          l.estacionId === row.id ? { ...l, estacionId: '' } : l
        )));
        if (editingId === row.id) resetForm();
        if (assigningId === row.id) {
          setAssigningId(null);
          setSelectedLectorIds([]);
        }
        showSuccess('Estación eliminada');
      } catch (err) {
        showError(err.message || 'Error al eliminar');
      }
    });
  };

  const openAssign = (row) => {
    setAssigningId(row.id);
    setSelectedLectorIds([...(row.lectorIds || [])]);
  };

  const toggleLector = (lectorId) => {
    setSelectedLectorIds((prev) => (
      prev.includes(lectorId)
        ? prev.filter((id) => id !== lectorId)
        : [...prev, lectorId]
    ));
  };

  const saveAssign = async () => {
    if (!assigningId) return;
    await runAction(`assign-est-${assigningId}`, async () => {
      try {
        const data = await apiFetch(`/admin/estaciones/${assigningId}/lectores`, {
          method: 'PUT',
          token: authToken,
          body: { lectorIds: selectedLectorIds }
        });
        const lectorIds = data.lectorIds || [];
        setEstaciones((prev) => prev.map((e) => (
          e.id === assigningId
            ? { ...e, lectorIds, lectoresCount: lectorIds.length }
            : {
              ...e,
              lectorIds: (e.lectorIds || []).filter((id) => !lectorIds.includes(id)),
              lectoresCount: (e.lectorIds || []).filter((id) => !lectorIds.includes(id)).length
            }
        )));
        setLectores((prev) => prev.map((l) => ({
          ...l,
          estacionId: lectorIds.includes(l.id)
            ? assigningId
            : (l.estacionId === assigningId ? '' : l.estacionId)
        })));
        setAssigningId(null);
        setSelectedLectorIds([]);
        showSuccess('Lectores asignados a la estación');
      } catch (err) {
        showError(err.message || 'Error al asignar lectores');
      }
    });
  };

  const handleDownloadConfig = async (row) => {
    await runAction(`config-est-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/estaciones/${row.id}/config`, { token: authToken });
        const slug = String(row.nombre || row.id).replace(/[^\w.-]+/g, '-').toLowerCase();
        downloadJson(`station-${slug}.config.json`, data.config);
        showSuccess(
          data.config?.readers?.length
            ? 'JSON de estación descargado (passwords kiosk vacíos si no regeneraste).'
            : 'JSON descargado sin lectores — asigná lectores antes de instalar.'
        );
      } catch (err) {
        showError(err.message || 'No se pudo descargar la config');
      }
    });
  };

  if (!canManage) {
    return <p className="theme-section-desc">Sin permiso lectores.manage.</p>;
  }

  return (
    <div className="estaciones-admin">
      <AdminBlock
        title={(
          <>
            <Server size={18} />
            {' '}
            {editingId ? 'Editar estación' : 'Nueva estación'}
          </>
        )}
        description="Agrupá varios lectores USB/serie en un mismo proceso Node (mini PC o Raspberry Pi) con servidor HTTP local."
      >
        <AdminFormCard onSubmit={handleSubmit}>
          <div className="admin-form-grid">
            <label>
              Nombre
              <input
                className="input-field"
                value={form.nombre}
                onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
                required
                placeholder="Ej. Mini PC ingreso / RPi patio"
              />
            </label>
            <label>
              Dirección red local
              <input
                className="input-field"
                value={form.direccionRedLocal}
                onChange={(e) => setForm((f) => ({ ...f, direccionRedLocal: e.target.value }))}
                placeholder="192.168.1.50"
              />
            </label>
            <label>
              Puerto servidor local
              <input
                className="input-field"
                type="number"
                min={1}
                max={65535}
                value={form.puertoServidorLocal}
                onChange={(e) => setForm((f) => ({
                  ...f,
                  puertoServidorLocal: Number(e.target.value) || 8787
                }))}
              />
            </label>
            <label>
              Secreto local
              <input
                className="input-field"
                value={form.secretoLocal}
                onChange={(e) => setForm((f) => ({ ...f, secretoLocal: e.target.value }))}
                placeholder={editingId ? '(dejar vacío para no cambiar)' : 'Vacío = se genera solo'}
                autoComplete="off"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ marginTop: '0.75rem' }}>
            <input
              type="checkbox"
              checked={form.activa !== false}
              onChange={(e) => setForm((f) => ({ ...f, activa: e.target.checked }))}
            />
            Estación activa
          </label>
          <div className="admin-form-actions" style={{ marginTop: '0.75rem' }}>
            <PendingButton
              type="submit"
              className="btn-primary"
              actionId={editingId ? `update-est-${editingId}` : 'create-est'}
              pendingAction={pendingAction}
              pendingLabel="Guardando…"
            >
              <PlusCircle size={16} />
              {editingId ? 'Guardar cambios' : 'Crear estación'}
            </PendingButton>
            {editingId && (
              <button type="button" className="btn-secondary" onClick={resetForm}>
                Cancelar
              </button>
            )}
          </div>
        </AdminFormCard>
      </AdminBlock>

      <AdminBlock title={`Estaciones (${estaciones.length})`}>
        {loading ? (
          <AdminLoading label="Cargando estaciones…" />
        ) : estaciones.length === 0 ? (
          <AdminEmpty
            icon={Server}
            title="Sin estaciones"
            description="Creá una estación y asignale lectores. El JSON unificado reemplaza un config por lector."
          />
        ) : (
          <AdminTable>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Red local</th>
                <th>Puerto</th>
                <th>Lectores</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {estaciones.map((row) => (
                <tr key={row.id}>
                  <td>{row.nombre}</td>
                  <td>
                    <code>{row.direccionRedLocal || '—'}</code>
                  </td>
                  <td>{row.puertoServidorLocal}</td>
                  <td>
                    {(row.lectorIds || []).length
                      ? (row.lectorIds || [])
                        .map((id) => lectoresById.get(id)?.nombre || id)
                        .join(', ')
                      : '—'}
                  </td>
                  <td>{row.activa !== false ? 'Activa' : 'Inactiva'}</td>
                  <td>
                    <div className="admin-row-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        title="Editar"
                        onClick={() => startEdit(row)}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => openAssign(row)}
                      >
                        Asignar lectores
                      </button>
                      <PendingButton
                        type="button"
                        className="btn-secondary"
                        actionId={`config-est-${row.id}`}
                        pendingAction={pendingAction}
                        pendingLabel="…"
                        onClick={() => handleDownloadConfig(row)}
                        title="Descargar config unificada"
                      >
                        <Download size={16} />
                        {' '}
                        Config
                      </PendingButton>
                      <button
                        type="button"
                        className="btn-icon"
                        title="Eliminar"
                        onClick={() => handleDelete(row)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminBlock>

      {assigningId && (
        <div className="admin-modal-backdrop" role="presentation" onClick={() => setAssigningId(null)}>
          <div
            className="admin-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Asignar lectores"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="admin-modal-title">Asignar lectores a la estación</h3>
            <p className="theme-section-desc">
              Los lectores marcados quedan en esta estación. Un lector solo puede pertenecer a una.
            </p>
            {lectores.length === 0 ? (
              <p className="theme-section-desc">No hay lectores creados. Creálos en Admin → Lectores.</p>
            ) : (
              <ul className="estaciones-assign-list">
                {lectores.map((l) => {
                  const elsewhere = l.estacionId
                    && l.estacionId !== assigningId
                    && estaciones.find((e) => e.id === l.estacionId);
                  return (
                    <li key={l.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedLectorIds.includes(l.id)}
                          onChange={() => toggleLector(l.id)}
                        />
                        <span>
                          {l.nombre}
                          {' '}
                          <code>
                            {l.doorId}
                            /
                            {l.readerId}
                          </code>
                          {elsewhere ? ` (ahora en: ${elsewhere.nombre})` : ''}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="admin-form-actions" style={{ marginTop: '1rem' }}>
              <PendingButton
                type="button"
                className="btn-primary"
                actionId={`assign-est-${assigningId}`}
                pendingAction={pendingAction}
                pendingLabel="Guardando…"
                onClick={saveAssign}
              >
                Guardar asignación
              </PendingButton>
              <button type="button" className="btn-secondary" onClick={() => setAssigningId(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EstacionesAdminSection;
