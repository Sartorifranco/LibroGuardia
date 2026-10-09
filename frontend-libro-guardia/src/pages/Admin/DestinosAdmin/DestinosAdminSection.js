import React, { useEffect, useState } from 'react';
import { MapPin, Pencil, PlusCircle, Trash2 } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import DoorAccessEditor from '../../../components/DoorAccessEditor';
import { AdminBlock, AdminEmpty } from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';
import { Modal, PageContainer } from '../../../components/admin-ui';

function DestinosAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();

  const [destinos, setDestinos] = useState([]);
  const [doorNames, setDoorNames] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [nombre, setNombre] = useState('');
  const [doorIds, setDoorIds] = useState([]);
  const [activo, setActivo] = useState(true);

  const canManage = hasPermission(currentUser, 'destinos.manage');

  const load = async () => {
    if (!canManage) return;
    try {
      const [destData, doorsData] = await Promise.all([
        apiFetch('/admin/destinos', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true }).catch(() => null)
      ]);
      setDestinos(destData.destinos || []);
      const map = {};
      (doorsData?.config?.doors || []).forEach((d) => {
        map[d.id] = d.name || d.id;
      });
      setDoorNames(map);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar los destinos');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, canManage]);

  const resetForm = () => {
    setEditingId(null);
    setNombre('');
    setDoorIds([]);
    setActivo(true);
    setFormOpen(false);
  };

  const openCreate = () => {
    setEditingId(null);
    setNombre('');
    setDoorIds([]);
    setActivo(true);
    setFormOpen(true);
  };

  const startEdit = (dest) => {
    setEditingId(dest.id);
    setNombre(dest.nombre || '');
    setDoorIds(Array.isArray(dest.doorIds) ? dest.doorIds : []);
    setActivo(dest.activo !== false);
    setFormOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    await runAction(editingId ? 'updateDestino' : 'createDestino', async () => {
      try {
        if (editingId) {
          const data = await apiFetch(`/admin/destinos/${editingId}`, {
            method: 'PUT',
            token: authToken,
            body: { nombre, doorIds, activo }
          });
          setDestinos((prev) => prev.map((x) => (x.id === editingId ? data.destino : x)));
          showSuccess('Guardado');
        } else {
          const data = await apiFetch('/admin/destinos', {
            method: 'POST',
            token: authToken,
            body: { nombre, doorIds, activo }
          });
          setDestinos((prev) => [...prev, data.destino].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))));
          showSuccess('Guardado');
        }
        resetForm();
      } catch (err) {
        showError(err.message || 'Error al guardar destino');
      }
    });
  };

  const handleDelete = async (dest) => {
    const ok = await confirm({
      title: 'Eliminar destino',
      message: `¿Eliminar “${dest.nombre}”?`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/admin/destinos/${dest.id}`, { method: 'DELETE', token: authToken });
      setDestinos((prev) => prev.filter((x) => x.id !== dest.id));
      if (editingId === dest.id) resetForm();
      showSuccess('Destino eliminado');
    } catch (err) {
      showError(err.message || 'Error al eliminar');
    }
  };

  if (!canManage) {
    return <p className="theme-section-desc">Sin permiso destinos.manage.</p>;
  }

  return (
    <PageContainer width="medium">
    <div className="destinos-admin">
      <p className="historial-meta">
        Un recorrido dice a qué lugar va la visita y por qué puertas llega. Si no hay recorridos, el empleado no puede cargar la visita.
      </p>
      <button type="button" className="btn btn-primary" onClick={openCreate}>
        <PlusCircle size={16} /> Nuevo recorrido
      </button>

      <Modal
        open={formOpen}
        title={editingId ? 'Editar recorrido' : 'Nuevo recorrido'}
        description="El nombre del lugar y las puertas para llegar."
        onClose={resetForm}
        size="lg"
        dirty={Boolean(nombre.trim() || doorIds.length)}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancelar</button>
            <PendingButton
              type="submit"
              form="destino-form"
              className="btn btn-primary"
              actionId={editingId ? 'updateDestino' : 'createDestino'}
              pendingAction={pendingAction}
            >
              {editingId ? 'Guardar cambios' : 'Crear destino'}
            </PendingButton>
          </>
        )}
      >
      <form id="destino-form" onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="destinoNombre">Nombre</label>
          <input
            id="destinoNombre"
            className="input-field"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Oficina de Sistemas"
            required
          />
        </div>
        <DoorAccessEditor
          authToken={authToken}
          allowedDoorIds={doorIds}
          onChange={(ids) => setDoorIds(Array.isArray(ids) ? ids : [])}
          forceRestricted
          label="Secuencia de puertas para llegar"
          hint="Elegí las puertas en el orden en que se recorren."
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          Activo
        </label>
      </form>
      </Modal>

      <AdminBlock title={`Destinos (${destinos.length})`}>
        {destinos.length === 0 ? (
          <AdminEmpty
            icon={MapPin}
            title="Todavía no hay destinos"
            description="Definí a dónde puede ir una visita y por qué puertas llega."
          />
        ) : (
          <div className="aui-card-grid">
            {destinos.map((dest) => (
              <article key={dest.id} className="aui-card">
                <div>
                  <strong>{dest.nombre}</strong>
                  <p className="historial-meta">
                    {(dest.doorIds || []).map((id) => doorNames[id] || id).join(' → ') || 'Sin puertas'}
                    {' · '}
                    {dest.activo === false ? 'Inactivo' : 'Activo'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-secondary-small" onClick={() => startEdit(dest)}>
                    <Pencil size={14} /> Editar
                  </button>
                  <button type="button" className="btn btn-danger-small" onClick={() => handleDelete(dest)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </AdminBlock>
    </div>
    </PageContainer>
  );
}

export default DestinosAdminSection;
