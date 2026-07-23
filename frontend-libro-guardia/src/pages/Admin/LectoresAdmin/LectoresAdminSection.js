import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  KeyRound,
  Pencil,
  PlusCircle,
  ScanLine,
  Trash2,
  X
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

/** Umbrales alineados con heartbeat 5 min del bridge (lib/lectores.js). */
export const CONNECTION_STATUS_META = {
  online: {
    label: 'En línea',
    className: 'lector-status lector-status--online',
    hint: 'Heartbeat en los últimos 10 minutos'
  },
  stale: {
    label: 'Sin señal reciente',
    className: 'lector-status lector-status--stale',
    hint: 'Último heartbeat entre 10 y 30 minutos'
  },
  offline: {
    label: 'Desconectado',
    className: 'lector-status lector-status--offline',
    hint: 'Nunca conectó o hace más de 30 minutos'
  }
};

const DIRECTION_LABELS = {
  ingreso: 'Ingreso',
  egreso: 'Egreso',
  ambos: 'Ambos'
};

const emptyCreateForm = () => ({
  nombre: '',
  doorId: '',
  readerId: '',
  direction: 'ingreso'
});

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatUltimaConexion(value) {
  if (!value) return 'Nunca';
  let ms = null;
  if (typeof value.toMillis === 'function') ms = value.toMillis();
  else if (value._seconds != null) ms = value._seconds * 1000;
  else if (value.seconds != null) ms = value.seconds * 1000;
  else ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString('es-AR');
  } catch {
    return '—';
  }
}

function readersForDoorId(doors, doorId) {
  const door = doors.find((d) => d.id === doorId);
  return Array.isArray(door?.readers) ? door.readers : [];
}

function CredentialsOnceModal({ title, password, config, onClose }) {
  if (!password && !config) return null;
  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
      <div className="admin-modal">
        <div className="admin-modal__head">
          <h4>{title}</h4>
          <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <p className="theme-section-desc">
          Esta contraseña se muestra <strong>una sola vez</strong>. Descargá el JSON y copialo a la mini PC
          como <code>door-reader.config.json</code>. Si la perdés, regenerá credenciales.
        </p>
        <label className="historial-meta">Contraseña generada</label>
        <input className="input-field" readOnly value={password || ''} onFocus={(e) => e.target.select()} />
        <div className="flex flex-wrap gap-2" style={{ marginTop: '1rem' }}>
          <PendingButton
            type="button"
            className="btn btn-primary"
            actionId="downloadOnceConfig"
            pendingAction={null}
            onClick={() => {
              downloadJson(`door-reader-${config?.doorId || 'lector'}.config.json`, config);
            }}
          >
            <Download size={16} /> Descargar JSON completo
          </PendingButton>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}

/** Modal de edición (position: fixed, centrado — mismo patrón que CredentialsOnceModal). */
function EditLectorModal({
  draft,
  doors,
  pendingAction,
  onChange,
  onDoorChange,
  onReaderChange,
  onSave,
  onClose
}) {
  if (!draft) return null;
  const readers = readersForDoorId(doors, draft.doorId);

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-lector-title">
      <div className="admin-modal admin-modal--wide">
        <div className="admin-modal__head">
          <h4 id="edit-lector-title">Editar lector</h4>
          <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <p className="historial-meta" style={{ marginBottom: '0.75rem' }}>
          Si cambiás puerta o readerId, actualizá también el <code>door-reader.config.json</code> en la mini PC
          (o regenerá y volvé a copiar el archivo).
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <div className="admin-form-grid">
            <label>
              <span className="historial-meta">Nombre</span>
              <input
                className="input-field"
                value={draft.nombre}
                onChange={(e) => onChange({ nombre: e.target.value })}
                placeholder="Ej. Ingreso Puerta 1"
                required
                autoFocus
              />
            </label>
            <label>
              <span className="historial-meta">Puerta</span>
              <select
                className="input-field"
                value={draft.doorId}
                onChange={(e) => onDoorChange(e.target.value)}
                required
              >
                <option value="">Elegir puerta…</option>
                {doors.map((d) => (
                  <option key={d.id} value={d.id}>{d.name || d.id}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Reader ID</span>
              <select
                className="input-field"
                value={draft.readerId}
                onChange={(e) => onReaderChange(e.target.value)}
                required
                disabled={!draft.doorId}
              >
                <option value="">Elegir lector de la puerta…</option>
                {readers.map((r) => (
                  <option key={r.id} value={r.id}>{r.id} ({r.direction || 'ambos'})</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Sentido</span>
              <select
                className="input-field"
                value={draft.direction}
                onChange={(e) => onChange({ direction: e.target.value })}
              >
                <option value="ingreso">Ingreso</option>
                <option value="egreso">Egreso</option>
                <option value="ambos">Ambos</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2" style={{ marginTop: '1rem' }}>
            <PendingButton
              type="submit"
              className="btn btn-primary"
              actionId="updateLector"
              pendingAction={pendingAction}
            >
              <Pencil size={16} /> Guardar cambios
            </PendingButton>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LectoresAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();

  const [lectores, setLectores] = useState([]);
  const [doors, setDoors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [editDraft, setEditDraft] = useState(null);
  const [onceModal, setOnceModal] = useState(null);

  const canManage = hasPermission(currentUser, 'lectores.manage');

  const createReaders = useMemo(
    () => readersForDoorId(doors, createForm.doorId),
    [doors, createForm.doorId]
  );

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      const [lectoresData, doorsData] = await Promise.all([
        apiFetch('/admin/lectores', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true })
      ]);
      setLectores(lectoresData.lectores || []);
      setDoors(doorsData?.config?.doors || []);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar los lectores');
    } finally {
      setLoading(false);
    }
  }, [authToken, canManage, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const applyDoorToForm = (prev, nextDoorId) => {
    const door = doors.find((d) => d.id === nextDoorId);
    const first = door?.readers?.[0];
    const dir = first?.direction;
    return {
      ...prev,
      doorId: nextDoorId,
      readerId: first?.id || '',
      direction: (dir === 'ingreso' || dir === 'egreso' || dir === 'ambos') ? dir : prev.direction
    };
  };

  const applyReaderToForm = (prev, nextReaderId, doorId) => {
    const reader = readersForDoorId(doors, doorId).find((r) => r.id === nextReaderId);
    const dir = reader?.direction;
    return {
      ...prev,
      readerId: nextReaderId,
      direction: (dir === 'ingreso' || dir === 'egreso' || dir === 'ambos') ? dir : prev.direction
    };
  };

  const startEdit = (row) => {
    setEditDraft({
      id: row.id,
      nombre: row.nombre || '',
      doorId: row.doorId || '',
      readerId: row.readerId || '',
      direction: row.direction || 'ingreso'
    });
  };

  const closeEdit = () => setEditDraft(null);

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    const { nombre, doorId, readerId, direction } = createForm;
    await runAction('createLector', async () => {
      try {
        const data = await apiFetch('/admin/lectores', {
          method: 'POST',
          token: authToken,
          body: { nombre, doorId, readerId, direction }
        });
        setLectores((prev) => [...prev, data.lector].sort((a, b) =>
          String(a.nombre).localeCompare(String(b.nombre))));
        setOnceModal({
          title: 'Lector creado — guardá la contraseña',
          password: data.password,
          config: data.config
        });
        showSuccess('Lector creado');
        setCreateForm(emptyCreateForm());
      } catch (err) {
        showError(err.message || 'Error al guardar lector');
      }
    });
  };

  const handleEditSave = async () => {
    if (!canManage || !editDraft?.id) return;
    const { id, nombre, doorId, readerId, direction } = editDraft;
    await runAction('updateLector', async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${id}`, {
          method: 'PUT',
          token: authToken,
          body: { nombre, doorId, readerId, direction }
        });
        setLectores((prev) => prev.map((x) => (x.id === id ? data.lector : x)));
        showSuccess(data.message || 'Lector actualizado');
        closeEdit();
      } catch (err) {
        showError(err.message || 'Error al actualizar lector');
      }
    });
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: 'Eliminar lector',
      message: `¿Eliminar “${row.nombre}”? También se borra el usuario de sistema ${row.usuarioSistemaId}. La mini PC dejará de autenticarse.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    await runAction(`deleteLector-${row.id}`, async () => {
      try {
        await apiFetch(`/admin/lectores/${row.id}`, { method: 'DELETE', token: authToken });
        setLectores((prev) => prev.filter((x) => x.id !== row.id));
        if (editDraft?.id === row.id) closeEdit();
        showSuccess('Lector eliminado');
      } catch (err) {
        showError(err.message || 'Error al eliminar');
      }
    });
  };

  const handleRegenerate = async (row) => {
    const ok = await confirm({
      title: 'Regenerar credenciales',
      message: `Se invalida la contraseña actual de ${row.usuarioSistemaId}. Tendrás que actualizar el JSON en la mini PC.`,
      confirmLabel: 'Regenerar',
      tone: 'danger'
    });
    if (!ok) return;
    await runAction(`regen-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${row.id}/regenerate-credentials`, {
          method: 'POST',
          token: authToken
        });
        setOnceModal({
          title: 'Credenciales regeneradas',
          password: data.password,
          config: data.config
        });
        showSuccess('Credenciales regeneradas');
      } catch (err) {
        showError(err.message || 'Error al regenerar');
      }
    });
  };

  const handleDownloadConfig = async (row) => {
    await runAction(`config-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${row.id}/config`, { token: authToken });
        downloadJson(`door-reader-${row.doorId || row.id}.config.json`, data.config);
        showSuccess('JSON descargado (sin contraseña). Si la perdiste, regenerá credenciales.');
      } catch (err) {
        showError(err.message || 'Error al descargar config');
      }
    });
  };

  if (!canManage) {
    return <p className="theme-section-desc">Sin permiso lectores.manage.</p>;
  }

  const doorName = (id) => doors.find((d) => d.id === id)?.name || id || '—';

  return (
    <div className="lectores-admin">
      <CredentialsOnceModal
        title={onceModal?.title}
        password={onceModal?.password}
        config={onceModal?.config}
        onClose={() => setOnceModal(null)}
      />

      <EditLectorModal
        draft={editDraft}
        doors={doors}
        pendingAction={pendingAction}
        onChange={(patch) => setEditDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
        onDoorChange={(nextDoorId) => setEditDraft((prev) => (prev ? applyDoorToForm(prev, nextDoorId) : prev))}
        onReaderChange={(nextReaderId) => setEditDraft((prev) => (
          prev ? applyReaderToForm(prev, nextReaderId, prev.doorId) : prev
        ))}
        onSave={handleEditSave}
        onClose={closeEdit}
      />

      <AdminBlock
        title="Nuevo lector"
        description="Al crear se genera el usuario kiosk (solo access.kiosk) y un JSON listo para la Raspberry Pi / mini PC."
      >
        <AdminFormCard onSubmit={handleCreateSubmit}>
          <div className="admin-form-grid">
            <label>
              <span className="historial-meta">Nombre</span>
              <input
                className="input-field"
                value={createForm.nombre}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, nombre: e.target.value }))}
                placeholder="Ej. Ingreso Puerta 1"
                required
              />
            </label>
            <label>
              <span className="historial-meta">Puerta</span>
              <select
                className="input-field"
                value={createForm.doorId}
                onChange={(e) => setCreateForm((prev) => applyDoorToForm(prev, e.target.value))}
                required
              >
                <option value="">Elegir puerta…</option>
                {doors.map((d) => (
                  <option key={d.id} value={d.id}>{d.name || d.id}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Reader ID</span>
              <select
                className="input-field"
                value={createForm.readerId}
                onChange={(e) => setCreateForm((prev) => applyReaderToForm(prev, e.target.value, prev.doorId))}
                required
                disabled={!createForm.doorId}
              >
                <option value="">Elegir lector de la puerta…</option>
                {createReaders.map((r) => (
                  <option key={r.id} value={r.id}>{r.id} ({r.direction || 'ambos'})</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Sentido</span>
              <select
                className="input-field"
                value={createForm.direction}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, direction: e.target.value }))}
              >
                <option value="ingreso">Ingreso</option>
                <option value="egreso">Egreso</option>
                <option value="ambos">Ambos</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2" style={{ marginTop: '0.75rem' }}>
            <PendingButton
              type="submit"
              className="btn btn-primary"
              actionId="createLector"
              pendingAction={pendingAction}
            >
              <PlusCircle size={16} /> Crear lector
            </PendingButton>
          </div>
        </AdminFormCard>
      </AdminBlock>

      <AdminBlock title={`Lectores (${lectores.length})`}>
        {loading ? (
          <AdminLoading label="Cargando lectores…" />
        ) : lectores.length === 0 ? (
          <AdminEmpty
            icon={ScanLine}
            title="Todavía no hay lectores"
            description="Creá uno para generar el usuario kiosk y el JSON de la mini PC."
          />
        ) : (
          <AdminTable>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Puerta</th>
                <th>Reader</th>
                <th>Sentido</th>
                <th>Conexión</th>
                <th>Última conexión</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {lectores.map((row) => {
                const status = CONNECTION_STATUS_META[row.connectionStatus] || CONNECTION_STATUS_META.offline;
                return (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.nombre}</strong>
                      <div className="theme-section-desc">{row.usuarioSistemaId}</div>
                    </td>
                    <td>{doorName(row.doorId)}</td>
                    <td><code>{row.readerId}</code></td>
                    <td>{DIRECTION_LABELS[row.direction] || row.direction}</td>
                    <td>
                      <span className={status.className} title={status.hint}>
                        <span className="lector-status__dot" aria-hidden />
                        {status.label}
                      </span>
                    </td>
                    <td>{formatUltimaConexion(row.ultimaConexion)}</td>
                    <td>
                      <div className="admin-row-actions">
                        <button type="button" className="admin-icon-btn" title="Editar" onClick={() => startEdit(row)}>
                          <Pencil size={16} />
                        </button>
                        <button type="button" className="admin-icon-btn" title="Descargar config" onClick={() => handleDownloadConfig(row)}>
                          <Download size={16} />
                        </button>
                        <button type="button" className="admin-icon-btn" title="Regenerar credenciales" onClick={() => handleRegenerate(row)}>
                          <KeyRound size={16} />
                        </button>
                        <button type="button" className="admin-icon-btn admin-icon-btn--danger" title="Eliminar" onClick={() => handleDelete(row)}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </AdminTable>
        )}
      </AdminBlock>

      <style>{`
        .lector-status {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.85rem;
          font-weight: 600;
        }
        .lector-status__dot {
          width: 0.55rem;
          height: 0.55rem;
          border-radius: 50%;
          background: currentColor;
        }
        .lector-status--online { color: #16a34a; }
        .lector-status--stale { color: #ca8a04; }
        .lector-status--offline { color: #dc2626; }
        .admin-row-actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }
        .admin-modal-backdrop {
          position: fixed; inset: 0; z-index: 80;
          background: rgba(0,0,0,0.55);
          display: flex; align-items: center; justify-content: center;
          padding: 1rem;
        }
        .admin-modal {
          background: var(--card, #1a1a1a);
          border: 1px solid var(--border, #2a2a2a);
          border-radius: 0.75rem;
          padding: 1.25rem;
          max-width: 32rem;
          width: 100%;
          max-height: calc(100vh - 2rem);
          overflow: auto;
        }
        .admin-modal--wide { max-width: 40rem; }
        .admin-modal__head {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 0.75rem;
        }
        .admin-form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
          gap: 0.75rem;
        }
        .admin-form-grid label { display: flex; flex-direction: column; gap: 0.35rem; }
      `}</style>
    </div>
  );
}

export default LectoresAdminSection;
