import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Cable,
  Download,
  Pencil,
  Plus,
  Server,
  Trash2,
  X
} from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import {
  AdminEmpty,
  AdminLoading,
  AdminTable
} from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';
import { CONNECTION_STATUS_META } from '../LectoresAdmin/LectoresAdminSection';

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

  const run = async (actionId, fn) => {
    if (typeof runAction === 'function') {
      await runAction(actionId, fn);
      return;
    }
    await fn();
  };

  const canManage = hasPermission(currentUser, 'lectores.manage');

  const [loading, setLoading] = useState(true);
  const [estaciones, setEstaciones] = useState([]);
  const [lectores, setLectores] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedLectorIds, setSelectedLectorIds] = useState([]);
  const [assigningId, setAssigningId] = useState(null);
  const [query, setQuery] = useState('');
  const loadGenRef = useRef(0);

  useEffect(() => {
    if (!canManage) return undefined;
    const gen = ++loadGenRef.current;
    setLoading(true);

    (async () => {
      try {
        const [estData, lecData] = await Promise.all([
          apiFetch('/admin/estaciones', { token: authToken, allowForbidden: true }),
          apiFetch('/admin/lectores', { token: authToken, allowForbidden: true })
        ]);
        if (gen !== loadGenRef.current) return;
        setEstaciones(estData.estaciones || []);
        setLectores(lecData.lectores || []);
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        showError(err.message || 'No se pudieron cargar las estaciones');
      } finally {
        if (gen === loadGenRef.current) setLoading(false);
      }
    })();

    return () => {
      loadGenRef.current += 1;
    };
  }, [authToken, canManage, showError]);

  const lectoresById = useMemo(() => {
    const map = new Map();
    lectores.forEach((l) => map.set(l.id, l));
    return map;
  }, [lectores]);

  const stats = useMemo(() => {
    const active = estaciones.filter((e) => e.activa !== false).length;
    const withReaders = estaciones.filter((e) => (e.lectorIds || []).length > 0).length;
    const linkedLectores = lectores.filter((l) => l.estacionId).length;
    return {
      total: estaciones.length,
      active,
      withReaders,
      orphanLectores: Math.max(0, lectores.length - linkedLectores)
    };
  }, [estaciones, lectores]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return estaciones;
    return estaciones.filter((e) => {
      const names = (e.lectorIds || [])
        .map((id) => lectoresById.get(id)?.nombre || '')
        .join(' ');
      return [
        e.nombre,
        e.direccionRedLocal,
        String(e.puertoServidorLocal || ''),
        names
      ].join(' ').toLowerCase().includes(q);
    });
  }, [estaciones, query, lectoresById]);

  const assigningStation = useMemo(
    () => estaciones.find((e) => e.id === assigningId) || null,
    [estaciones, assigningId]
  );

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(false);
  };

  const openCreate = () => {
    setAssigningId(null);
    setSelectedLectorIds([]);
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
  };

  const startEdit = (row) => {
    setAssigningId(null);
    setSelectedLectorIds([]);
    setEditingId(row.id);
    setForm({
      nombre: row.nombre || '',
      direccionRedLocal: row.direccionRedLocal || '',
      puertoServidorLocal: Number(row.puertoServidorLocal) || 8787,
      secretoLocal: row.secretoLocal || '',
      activa: row.activa !== false
    });
    setFormOpen(true);
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

    await run(editingId ? `update-est-${editingId}` : 'create-est', async () => {
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
          showSuccess('Estación creada. Asigná lectores y descargá el JSON.');
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
    await run(`del-est-${row.id}`, async () => {
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
    setFormOpen(false);
    setEditingId(null);
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
    await run(`assign-est-${assigningId}`, async () => {
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
    await run(`config-est-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/estaciones/${row.id}/config`, { token: authToken });
        const slug = String(row.nombre || row.id).replace(/[^\w.-]+/g, '-').toLowerCase();
        downloadJson(`station-${slug}.config.json`, data.config);
        showSuccess(
          data.config?.readers?.length
            ? 'JSON de estación descargado.'
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
      <div className="estaciones-admin__toolbar">
        <label className="estaciones-admin__search">
          <span className="sr-only">Buscar estación</span>
          <input
            className="input-field"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, IP o lector…"
          />
        </label>
        <button
          type="button"
          className="btn btn-primary estaciones-admin__create-btn"
          onClick={openCreate}
        >
          <Plus size={16} />
          Nueva estación
        </button>
      </div>

      <div className="estaciones-admin__stats" aria-label="Resumen de estaciones">
        <span className="estaciones-admin__stat">
          <strong>{stats.total}</strong>
          {' '}
          estaciones
        </span>
        <span className="estaciones-admin__stat estaciones-admin__stat--ok">
          <strong>{stats.active}</strong>
          {' '}
          activas
        </span>
        <span className="estaciones-admin__stat">
          <strong>{stats.withReaders}</strong>
          {' '}
          con lectores
        </span>
        {stats.orphanLectores > 0 && (
          <span className="estaciones-admin__stat estaciones-admin__stat--warn">
            <strong>{stats.orphanLectores}</strong>
            {' '}
            lectores sin estación
          </span>
        )}
      </div>

      <section className="estaciones-admin__list" aria-label="Listado de estaciones">
        {loading && estaciones.length === 0 ? (
          <AdminLoading label="Cargando estaciones…" />
        ) : filtered.length === 0 ? (
          <AdminEmpty
            icon={Server}
            title={estaciones.length === 0 ? 'Sin estaciones' : 'Sin resultados'}
            description={
              estaciones.length === 0
                ? 'Creá una estación, asignale lectores y descargá el JSON unificado para instalar el bridge.'
                : 'Probá otro término de búsqueda.'
            }
          />
        ) : (
          <AdminTable className="estaciones-admin__table">
            <thead>
              <tr>
                <th>Estación</th>
                <th>Red</th>
                <th>Lectores</th>
                <th>Estado</th>
                <th>Conexión</th>
                <th className="estaciones-admin__th-actions">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const readerNames = (row.lectorIds || [])
                  .map((id) => lectoresById.get(id)?.nombre || id);
                const readerCount = readerNames.length;
                return (
                  <tr key={row.id} className={row.activa === false ? 'estaciones-admin__row--off' : ''}>
                    <td>
                      <div className="estaciones-admin__name-cell">
                        <span className="estaciones-admin__name">{row.nombre}</span>
                      </div>
                    </td>
                    <td>
                      <div className="estaciones-admin__net">
                        <code>{row.direccionRedLocal || '—'}</code>
                        <span className="estaciones-admin__port">:{row.puertoServidorLocal || 8787}</span>
                      </div>
                    </td>
                    <td>
                      {readerCount === 0 ? (
                        <span className="estaciones-admin__muted">Sin lectores</span>
                      ) : (
                        <div className="estaciones-admin__readers" title={readerNames.join(', ')}>
                          <span className="estaciones-admin__chip">
                            <Cable size={12} aria-hidden />
                            {readerCount}
                          </span>
                          <span className="estaciones-admin__readers-text">
                            {readerNames.slice(0, 2).join(', ')}
                            {readerCount > 2 ? ` +${readerCount - 2}` : ''}
                          </span>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`estaciones-admin__status${row.activa !== false ? ' is-on' : ' is-off'}`}>
                        {row.activa !== false ? 'Activa' : 'Inactiva'}
                      </span>
                    </td>
                    <td>
                      {(() => {
                        const conn = CONNECTION_STATUS_META[row.connectionStatus] || CONNECTION_STATUS_META.offline;
                        return (
                          <span className={conn.className} title={conn.hint}>
                            {conn.label}
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      <div className="estaciones-admin__actions">
                        <button
                          type="button"
                          className="estaciones-admin__icon-btn"
                          title="Editar"
                          aria-label={`Editar ${row.nombre}`}
                          onClick={() => startEdit(row)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="estaciones-admin__icon-btn"
                          title="Asignar lectores"
                          aria-label={`Asignar lectores a ${row.nombre}`}
                          onClick={() => openAssign(row)}
                        >
                          <Cable size={15} />
                        </button>
                        <PendingButton
                          type="button"
                          className="estaciones-admin__icon-btn"
                          actionId={`config-est-${row.id}`}
                          pendingAction={pendingAction}
                          pendingLabel="…"
                          onClick={() => handleDownloadConfig(row)}
                          title="Descargar config JSON"
                          aria-label={`Descargar config de ${row.nombre}`}
                        >
                          <Download size={15} />
                        </PendingButton>
                        <button
                          type="button"
                          className="estaciones-admin__icon-btn estaciones-admin__icon-btn--danger"
                          title="Eliminar"
                          aria-label={`Eliminar ${row.nombre}`}
                          onClick={() => handleDelete(row)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </AdminTable>
        )}
      </section>

      {formOpen && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onClick={resetForm}>
          <div
            className="admin-modal estaciones-admin__modal estaciones-admin__modal--form"
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? 'Editar estación' : 'Nueva estación'}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="estaciones-admin__modal-head">
              <div>
                <h3 className="admin-modal-title">
                  {editingId ? 'Editar estación' : 'Nueva estación'}
                </h3>
                <p className="theme-section-desc">
                  PC de planta con lectores USB y servidor HTTP local (puerto 8787).
                </p>
              </div>
              <button
                type="button"
                className="estaciones-admin__icon-btn"
                onClick={resetForm}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <form onSubmit={handleSubmit} className="estaciones-admin__form estaciones-admin__form--modal">
              <label className="estaciones-admin__field">
                <span>Nombre</span>
                <input
                  className="input-field"
                  value={form.nombre}
                  onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
                  required
                  placeholder="Ej. PC ingreso / RPi patio"
                  autoFocus
                />
              </label>
              <div className="estaciones-admin__form-row">
                <label className="estaciones-admin__field">
                  <span>IP local</span>
                  <input
                    className="input-field"
                    value={form.direccionRedLocal}
                    onChange={(e) => setForm((f) => ({ ...f, direccionRedLocal: e.target.value }))}
                    placeholder="192.168.0.10"
                    inputMode="decimal"
                  />
                </label>
                <label className="estaciones-admin__field estaciones-admin__field--narrow">
                  <span>Puerto</span>
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
              </div>
              <label className="estaciones-admin__field">
                <span>Secreto local</span>
                <input
                  className="input-field"
                  value={form.secretoLocal}
                  onChange={(e) => setForm((f) => ({ ...f, secretoLocal: e.target.value }))}
                  placeholder={editingId ? 'Vacío = no cambiar' : 'Vacío = se genera solo'}
                  autoComplete="off"
                />
              </label>
              <label className="estaciones-admin__check">
                <input
                  type="checkbox"
                  checked={form.activa !== false}
                  onChange={(e) => setForm((f) => ({ ...f, activa: e.target.checked }))}
                />
                Estación activa
              </label>
              <div className="estaciones-admin__modal-footer">
                <button type="button" className="btn btn-secondary" onClick={resetForm}>
                  Cancelar
                </button>
                <PendingButton
                  type="submit"
                  className="btn btn-primary"
                  actionId={editingId ? `update-est-${editingId}` : 'create-est'}
                  pendingAction={pendingAction}
                  pendingLabel="Guardando…"
                >
                  {editingId ? 'Guardar cambios' : 'Crear estación'}
                </PendingButton>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {assigningId && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onClick={() => setAssigningId(null)}>
          <div
            className="admin-modal estaciones-admin__modal"
            role="dialog"
            aria-modal="true"
            aria-label="Asignar lectores"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="estaciones-admin__modal-head">
              <div>
                <h3 className="admin-modal-title">Asignar lectores</h3>
                <p className="theme-section-desc">
                  {assigningStation?.nombre || 'Estación'}
                  {' · '}
                  Un lector solo puede estar en una estación.
                </p>
              </div>
              <button
                type="button"
                className="estaciones-admin__icon-btn"
                onClick={() => setAssigningId(null)}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            {lectores.length === 0 ? (
              <p className="theme-section-desc">No hay lectores. Creálos en Admin → Lectores.</p>
            ) : (
              <ul className="estaciones-assign-list">
                {lectores.map((l) => {
                  const elsewhere = l.estacionId
                    && l.estacionId !== assigningId
                    && estaciones.find((e) => e.id === l.estacionId);
                  return (
                    <li key={l.id}>
                      <label className="estaciones-assign-item">
                        <input
                          type="checkbox"
                          checked={selectedLectorIds.includes(l.id)}
                          onChange={() => toggleLector(l.id)}
                        />
                        <span className="estaciones-assign-item__body">
                          <strong>{l.nombre}</strong>
                          <code>
                            {l.doorId}
                            /
                            {l.readerId}
                          </code>
                          {elsewhere ? (
                            <span className="estaciones-admin__chip estaciones-admin__chip--warn">
                              Ahora en:
                              {' '}
                              {elsewhere.nombre}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="estaciones-admin__modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setAssigningId(null)}>
                Cancelar
              </button>
              <PendingButton
                type="button"
                className="btn btn-primary"
                actionId={`assign-est-${assigningId}`}
                pendingAction={pendingAction}
                pendingLabel="Guardando…"
                onClick={saveAssign}
              >
                Guardar
                {selectedLectorIds.length ? ` (${selectedLectorIds.length})` : ''}
              </PendingButton>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default EstacionesAdminSection;
