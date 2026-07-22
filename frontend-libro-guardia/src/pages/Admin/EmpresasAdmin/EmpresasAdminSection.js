import React, { useEffect, useState } from 'react';
import { Building2, Pencil, PlusCircle, Trash2 } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { AdminBlock, AdminEmpty } from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';

/** Dominio canónico: host sin @, minúsculas (mismo criterio que el backend). */
function normalizeDomainInput(raw) {
  let value = String(raw || '').trim().toLowerCase();
  if (value.includes('@')) value = value.split('@').pop() || '';
  return value.replace(/\.+$/, '').trim();
}

function EmpresasAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();

  const [empresas, setEmpresas] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [nombre, setNombre] = useState('');
  const [dominiosText, setDominiosText] = useState('');
  const [activa, setActiva] = useState(true);

  const canManage = hasPermission(currentUser, 'empresas.manage');

  const load = async () => {
    if (!canManage) return;
    try {
      const data = await apiFetch('/admin/empresas', { token: authToken, allowForbidden: true });
      setEmpresas(data.empresas || []);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar las empresas');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, canManage]);

  const resetForm = () => {
    setEditingId(null);
    setNombre('');
    setDominiosText('');
    setActiva(true);
  };

  const startEdit = (emp) => {
    setEditingId(emp.id);
    setNombre(emp.nombre || '');
    setDominiosText((emp.dominiosPermitidos || []).join(', '));
    setActiva(emp.activa !== false);
  };

  const parseDominios = () => {
    const parts = String(dominiosText || '')
      .split(/[,;\s]+/)
      .map(normalizeDomainInput)
      .filter(Boolean);
    return [...new Set(parts)];
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    const dominiosPermitidos = parseDominios();
    await runAction(editingId ? 'updateEmpresa' : 'createEmpresa', async () => {
      try {
        if (editingId) {
          const data = await apiFetch(`/admin/empresas/${editingId}`, {
            method: 'PUT',
            token: authToken,
            body: { nombre, dominiosPermitidos, activa }
          });
          setEmpresas((prev) => prev.map((x) => (x.id === editingId ? data.empresa : x)));
          showSuccess('Empresa actualizada');
        } else {
          const data = await apiFetch('/admin/empresas', {
            method: 'POST',
            token: authToken,
            body: { nombre, dominiosPermitidos, activa }
          });
          setEmpresas((prev) => [...prev, data.empresa].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))));
          showSuccess('Empresa creada');
        }
        resetForm();
      } catch (err) {
        showError(err.message || 'Error al guardar empresa');
      }
    });
  };

  const handleDelete = async (emp) => {
    const ok = await confirm({
      title: 'Eliminar empresa',
      message: `¿Eliminar “${emp.nombre}”? Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/admin/empresas/${emp.id}`, { method: 'DELETE', token: authToken });
      setEmpresas((prev) => prev.filter((x) => x.id !== emp.id));
      if (editingId === emp.id) resetForm();
      showSuccess('Empresa eliminada');
    } catch (err) {
      showError(err.message || 'Error al eliminar');
    }
  };

  if (!canManage) {
    return <p className="theme-section-desc">Sin permiso empresas.manage.</p>;
  }

  return (
    <div className="empresas-admin">
      <AdminBlock title={<><Building2 size={18} /> {editingId ? 'Editar empresa' : 'Nueva empresa'}</>}>
      <form onSubmit={handleSubmit} className="admin-form-card space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="empresaNombre">Nombre</label>
          <input
            id="empresaNombre"
            className="input-field"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="empresaDominios">
            Dominios permitidos
          </label>
          <input
            id="empresaDominios"
            className="input-field"
            value={dominiosText}
            onChange={(e) => setDominiosText(e.target.value)}
            placeholder="vespasiani.com, otra.com.ar"
          />
          <p className="historial-meta" style={{ marginTop: '0.35rem' }}>
            Host sin @, minúsculas. Separá con coma. Si pegás user@dominio.com se toma solo el dominio.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={activa} onChange={(e) => setActiva(e.target.checked)} />
          Activa
        </label>
        <div className="flex flex-wrap gap-2">
          <PendingButton
            type="submit"
            className="btn btn-primary"
            actionId={editingId ? 'updateEmpresa' : 'createEmpresa'}
            pendingAction={pendingAction}
          >
            <PlusCircle size={16} /> {editingId ? 'Guardar cambios' : 'Crear empresa'}
          </PendingButton>
          {editingId && (
            <button type="button" className="btn btn-secondary" onClick={resetForm}>
              Cancelar
            </button>
          )}
        </div>
      </form>
      </AdminBlock>

      <AdminBlock title={`Empresas (${empresas.length})`}>
        {empresas.length === 0 ? (
          <AdminEmpty
            icon={Building2}
            title="Todavía no hay empresas"
            description="Cargá la primera para habilitar dominios de autoregistro."
          />
        ) : (
          <ul className="user-list">
            {empresas.map((emp) => (
              <li key={emp.id} className="user-list-item">
                <div>
                  <strong>{emp.nombre}</strong>
                  <p className="historial-meta">
                    {(emp.dominiosPermitidos || []).join(', ') || 'Sin dominios'}
                    {' · '}
                    {emp.activa === false ? 'Inactiva' : 'Activa'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-secondary-small" onClick={() => startEdit(emp)}>
                    <Pencil size={14} /> Editar
                  </button>
                  <button type="button" className="btn btn-danger-small" onClick={() => handleDelete(emp)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AdminBlock>
    </div>
  );
}

export default EmpresasAdminSection;
