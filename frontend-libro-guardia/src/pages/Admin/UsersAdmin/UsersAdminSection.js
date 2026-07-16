import React, { useEffect, useMemo, useState } from 'react';
import { UserPlus, KeyRound, Edit, Trash2, PlusCircle, XCircle, ToggleRight, ToggleLeft, Save } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { hasPermission, canManageTargetUser, PERMISSION_LABELS } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';

/**
 * Sección "Usuarios" del panel de administración.
 * @param {{ pendingAction: string|null, runAction: Function, permissionKeys: string[] }} props
 */
function UsersAdminSection({ pendingAction, runAction, permissionKeys }) {
  const { authToken, currentUser, systemRoles } = useAuth();
  const { showSuccess, showError, setError } = useToast();
  const { confirm } = useConfirm();

  const [, setLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState('guardia');
  const [editingUser, setEditingUser] = useState(null);
  const [editedUsername, setEditedUsername] = useState('');
  const [editedUserRole, setEditedUserRole] = useState('');
  const [editedUserPassword, setEditedUserPassword] = useState('');
  const [editedUserActive, setEditedUserActive] = useState(true);
  const [editingUserPermissions, setEditingUserPermissions] = useState([]);

  useEffect(() => {
    const fetchUsers = async () => {
      if (!currentUser || !hasPermission(currentUser, 'users.view')) {
        setUsers([]);
        return;
      }
      try {
        setLoading(true);
        const data = await apiFetch('/admin/users', { token: authToken });
        setUsers(data.users);
        setError(null);
      } catch (err) {
        console.error("Error al obtener usuarios:", err);
        setError(err.message || "Error al cargar la lista de usuarios. Asegúrese de tener permisos de administrador.");
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [currentUser, authToken]);

  const assignableRoles = useMemo(() => {
    if (!currentUser) return [];
    return (systemRoles.length ? systemRoles : [
      { id: 'monitoreo', label: 'Monitoreo' },
      { id: 'guardia', label: 'Guardia' },
      { id: 'supervisor', label: 'Supervisor' },
      { id: 'admin', label: 'Administrador' }
    ]).filter((role) => canManageTargetUser(currentUser, { role: role.id }));
  }, [currentUser, systemRoles]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setError(null);
    await runAction('createUser', async () => {
      try {
        await apiFetch('/admin/users', {
          method: 'POST',
          token: authToken,
          body: { username: newUsername, password: newUserPassword, role: newUserRole }
        });

        setNewUsername('');
        setNewUserPassword('');
        setNewUserRole('guardia');
        showSuccess('Usuario creado exitosamente.');
        const usersData = await apiFetch('/admin/users', { token: authToken });
        setUsers(usersData.users);
      } catch (createError) {
        console.error('Error al crear usuario:', createError);
        setError(createError.message || 'Error al crear usuario.');
      }
    });
  };

  const handleEditUser = (user) => {
    setEditingUser(user);
    setEditedUsername(user.username);
    setEditedUserRole(user.role);
    setEditedUserPassword('');
    setEditedUserActive(user.active);
    setEditingUserPermissions(user.customPermissions || []);
  };

  const handleSaveUserEdit = async (e) => {
    e.preventDefault();
    setError(null);
    await runAction('saveUserEdit', async () => {
      try {
        const updateData = { role: editedUserRole, active: editedUserActive };
        if (editedUserPassword) {
          updateData.password = editedUserPassword;
        }

        await apiFetch(`/admin/users/${editingUser.id}`, {
          method: 'PUT',
          token: authToken,
          body: updateData
        });

        setEditingUser(null);
        showSuccess('Usuario actualizado exitosamente.');
        const usersData = await apiFetch('/admin/users', { token: authToken });
        setUsers(usersData.users);
      } catch (saveError) {
        console.error('Error al actualizar usuario:', saveError);
        setError(saveError.message || 'Error al actualizar usuario.');
      }
    });
  };

  const handleDeleteUser = async (userId) => {
    const ok = await confirm({
      title: 'Eliminar usuario',
      message: 'Esta acción es irreversible. El usuario perderá el acceso al sistema.',
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    setError(null);
    setLoading(true);
    try {
      await apiFetch(`/admin/users/${userId}`, {
        method: 'DELETE',
        token: authToken
      });

      showSuccess("Usuario eliminado exitosamente.");
      const usersData = await apiFetch('/admin/users', { token: authToken });
      setUsers(usersData.users);

    } catch (error) {
      console.error("Error al eliminar usuario:", error);
      setError(error.message || "Error al eliminar usuario.");
    } finally {
      setLoading(false);
    }
  };

  const toggleEditingUserPermission = (permission) => {
    setEditingUserPermissions((prev) =>
      prev.includes(permission) ? prev.filter((item) => item !== permission) : [...prev, permission]
    );
  };

  const handleSaveUserPermissions = async () => {
    if (!editingUser) return;
    await runAction('saveUserPermissions', async () => {
      try {
        const data = await apiFetch(`/admin/users/${editingUser.id}/permissions`, {
          method: 'PUT',
          token: authToken,
          body: { permissions: editingUserPermissions }
        });
        showSuccess('Permisos personalizados guardados.');
        setUsers((prev) => prev.map((user) => (user.id === data.user.id ? data.user : user)));
      } catch (err) {
        showError(err.message || 'Error al guardar permisos del usuario');
      }
    });
  };

  if (!hasPermission(currentUser, 'users.view')) return null;

  return (
    <>
      {hasPermission(currentUser, 'users.create') && (
        <div className="admin-sub-section">
          <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2"><UserPlus size={20} /> Crear nuevo usuario</h3>
          <form onSubmit={handleCreateUser} className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input type="text" id="newUsername" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="input-field" placeholder="Usuario" required />
            <input type="password" id="newUserPassword" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} className="input-field" placeholder="Contraseña" required />
            <select id="newUserRole" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} className="input-field bg-white">
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.id}>{role.label}</option>
              ))}
            </select>
            <PendingButton type="submit" actionId="createUser" pendingAction={pendingAction} className="btn btn-success md:col-span-3" pendingLabel="Creando usuario...">
              <PlusCircle size={20} /> Crear usuario
            </PendingButton>
          </form>
        </div>
      )}

      <div className="admin-sub-section">
        <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2"><KeyRound size={20} /> Gestión de usuarios</h3>
        {users.length === 0 ? (
          <p className="text-gray-500 text-center py-4">No hay usuarios registrados.</p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {users.map((user) => (
              <div key={user.id} className="user-list-item">
                <div>
                  <p className="font-semibold text-gray-900">{user.username}</p>
                  <p className="text-sm text-gray-600">Rol: <span className="capitalize">{systemRoles.find((r) => r.id === user.role)?.label || user.role}</span> · {user.active ? 'Activo' : 'Inactivo'}</p>
                </div>
                <div className="flex items-center gap-2 mt-2 sm:mt-0">
                  {hasPermission(currentUser, 'users.edit') && canManageTargetUser(currentUser, user) && (
                    <button onClick={() => handleEditUser(user)} className="btn btn-secondary-small"><Edit size={16} /> Editar</button>
                  )}
                  {hasPermission(currentUser, 'users.delete') && user.id !== currentUser.id && canManageTargetUser(currentUser, user) && (
                    <button onClick={() => handleDeleteUser(user.id)} className="btn btn-danger-small"><Trash2 size={16} /> Eliminar</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editingUser && (
        <div className="modal-overlay">
          <div className="modal-content max-w-2xl">
            <button type="button" className="close-button" onClick={() => setEditingUser(null)} aria-label="Cerrar">
              <XCircle size={24} />
            </button>
            <h3 className="text-xl font-semibold text-gray-800 mb-4">Editar usuario: {editingUser.username}</h3>
            <form onSubmit={handleSaveUserEdit} className="space-y-4">
              <input type="text" id="editedUsername" value={editedUsername} className="input-field" disabled />
              {hasPermission(currentUser, 'users.edit') && canManageTargetUser(currentUser, editingUser) && (
                <select id="editedUserRole" value={editedUserRole} onChange={(e) => setEditedUserRole(e.target.value)} className="input-field bg-white" disabled={editingUser.id === currentUser.id}>
                  {assignableRoles.map((role) => (
                    <option key={role.id} value={role.id}>{role.label}</option>
                  ))}
                </select>
              )}
              <input type="password" id="editedUserPassword" value={editedUserPassword} onChange={(e) => setEditedUserPassword(e.target.value)} className="input-field" placeholder="Nueva contraseña (opcional)" />
              {hasPermission(currentUser, 'users.edit') && canManageTargetUser(currentUser, editingUser) && (
                <button type="button" onClick={() => setEditedUserActive(!editedUserActive)} className={`flex items-center gap-2 px-4 py-2 rounded-md ${editedUserActive ? 'bg-green-500 text-white' : 'bg-gray-300 text-gray-700'}`} disabled={editingUser.id === currentUser.id}>
                  {editedUserActive ? <ToggleRight size={20} /> : <ToggleLeft size={20} />} {editedUserActive ? 'Activo' : 'Inactivo'}
                </button>
              )}
              {hasPermission(currentUser, 'settings.permissions') && (
                <div>
                  <h4 className="font-medium mb-2">Permisos personalizados</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto border rounded-md p-3">
                    {(permissionKeys.length ? permissionKeys : Object.keys(PERMISSION_LABELS)).map((permission) => (
                      <label key={permission} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={editingUserPermissions.includes(permission)} onChange={() => toggleEditingUserPermission(permission)} />
                        {PERMISSION_LABELS[permission] || permission}
                      </label>
                    ))}
                  </div>
                  <PendingButton type="button" actionId="saveUserPermissions" pendingAction={pendingAction} className="btn btn-secondary mt-3" pendingLabel="Guardando..." onClick={handleSaveUserPermissions}>
                    Guardar permisos personalizados
                  </PendingButton>
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setEditingUser(null)} className="btn btn-secondary"><XCircle size={20} /> Cancelar</button>
                <PendingButton type="submit" actionId="saveUserEdit" pendingAction={pendingAction} className="btn btn-primary" pendingLabel="Guardando...">
                  <Save size={20} /> Guardar cambios
                </PendingButton>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export default UsersAdminSection;
