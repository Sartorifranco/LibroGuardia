import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  UserPlus,
  Edit,
  Trash2,
  PlusCircle,
  XCircle,
  ToggleRight,
  ToggleLeft,
  Save,
  Users,
  Unlock,
  Search,
  ChevronLeft,
  ChevronRight,
  Filter,
  X
} from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import {
  AdminBlock,
  AdminEmpty,
  AdminLoading,
  AdminTable
} from '../../../components/admin/AdminUi';
import { hasPermission, canManageTargetUser, PERMISSION_LABELS, isAccessStationAccount, ACCESS_STATION_ROLE_ID, ACCESS_STATION_ROLE_LABEL, humanRoleLabel } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';

const PAGE_SIZES = [25, 50, 100];

function roleLabel(systemRoles, roleId) {
  return humanRoleLabel(systemRoles, roleId);
}

/**
 * Sección "Usuarios" del panel de administración.
 * Lista densa con búsqueda, filtros y paginación (apto para cientos de cuentas).
 */
function UsersAdminSection({ pendingAction, runAction, permissionKeys }) {
  const { authToken, currentUser, systemRoles } = useAuth();
  const { showSuccess, showError, setError } = useToast();
  const { confirm } = useConfirm();

  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState('guardia');
  const [editingUser, setEditingUser] = useState(null);
  const [editedUsername, setEditedUsername] = useState('');
  const [editedUserRole, setEditedUserRole] = useState('');
  const [editedUserPassword, setEditedUserPassword] = useState('');
  const [editedUserActive, setEditedUserActive] = useState(true);
  const [editingUserPermissions, setEditingUserPermissions] = useState([]);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const [showAccessStations, setShowAccessStations] = useState(false);

  const canCreate = hasPermission(currentUser, 'users.create');
  const canEdit = hasPermission(currentUser, 'users.edit');
  const canDelete = hasPermission(currentUser, 'users.delete');
  const canUnlock = canEdit || hasPermission(currentUser, 'lectores.manage');
  const canPerms = hasPermission(currentUser, 'settings.permissions');

  const reloadUsers = useCallback(async () => {
    if (!currentUser || !hasPermission(currentUser, 'users.view')) {
      setUsers([]);
      return;
    }
    const data = await apiFetch('/admin/users', { token: authToken });
    setUsers(data.users || []);
  }, [authToken, currentUser]);

  useEffect(() => {
    let cancelled = false;
    const fetchUsers = async () => {
      if (!currentUser || !hasPermission(currentUser, 'users.view')) {
        setUsers([]);
        return;
      }
      try {
        setLoading(true);
        const data = await apiFetch('/admin/users', { token: authToken });
        if (cancelled) return;
        setUsers(data.users || []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.error('Error al obtener usuarios:', err);
        setError(err.message || 'Error al cargar la lista de usuarios. Asegúrese de tener permisos de administrador.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUsers();
    return () => { cancelled = true; };
  }, [currentUser, authToken, setError]);

  const assignableRoles = useMemo(() => {
    if (!currentUser) return [];
    return (systemRoles.length ? systemRoles : [
      { id: 'monitoreo', label: 'Monitoreo' },
      { id: 'guardia', label: 'Guardia' },
      { id: 'supervisor', label: 'Supervisor' },
      { id: 'admin', label: 'Administrador' }
    ]).filter((role) => (
      role.id !== ACCESS_STATION_ROLE_ID
      && canManageTargetUser(currentUser, { role: role.id })
    ));
  }, [currentUser, systemRoles]);

  const humanUsers = useMemo(
    () => users.filter((u) => !isAccessStationAccount(u)),
    [users]
  );
  const accessStationUsers = useMemo(
    () => users.filter((u) => isAccessStationAccount(u)),
    [users]
  );
  const visibleUsers = showAccessStations ? users : humanUsers;

  const roleOptions = useMemo(() => {
    const ids = new Set(visibleUsers.map((u) => u.role).filter(Boolean));
    return [...ids]
      .map((id) => ({ id, label: roleLabel(systemRoles, id) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }, [visibleUsers, systemRoles]);

  const stats = useMemo(() => {
    const active = humanUsers.filter((u) => u.active !== false).length;
    return {
      total: humanUsers.length,
      active,
      inactive: humanUsers.length - active,
      customPerms: humanUsers.filter((u) => (u.customPermissions || []).length > 0).length,
      stations: accessStationUsers.length
    };
  }, [humanUsers, accessStationUsers]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleUsers.filter((user) => {
      if (roleFilter !== 'all' && user.role !== roleFilter) return false;
      if (statusFilter === 'active' && user.active === false) return false;
      if (statusFilter === 'inactive' && user.active !== false) return false;
      if (!q) return true;
      const hay = [
        user.username,
        user.email,
        user.nombre,
        user.role,
        roleLabel(systemRoles, user.role)
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [visibleUsers, search, roleFilter, statusFilter, systemRoles]);

  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageSlice = useMemo(() => {
    const start = safePage * pageSize;
    return filteredUsers.slice(start, start + pageSize);
  }, [filteredUsers, safePage, pageSize]);

  useEffect(() => {
    setPage(0);
  }, [search, roleFilter, statusFilter, pageSize, showAccessStations]);

  const clearFilters = () => {
    setSearch('');
    setRoleFilter('all');
    setStatusFilter('all');
  };

  const hasActiveFilters = Boolean(search.trim()) || roleFilter !== 'all' || statusFilter !== 'all';

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
        setCreateOpen(false);
        showSuccess('Usuario creado exitosamente.');
        await reloadUsers();
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
        await reloadUsers();
      } catch (saveError) {
        console.error('Error al actualizar usuario:', saveError);
        setError(saveError.message || 'Error al actualizar usuario.');
      }
    });
  };

  const handleClearLoginFailures = async (user) => {
    const username = user.username || user.id;
    const ok = await confirm({
      title: 'Destrabar intentos de login',
      message: `¿Limpiar el bloqueo por intentos fallidos de “${username}”? Podrá volver a autenticarse de inmediato.`,
      confirmLabel: 'Destrabar',
      tone: 'default'
    });
    if (!ok) return;
    await runAction(`unlock-user-${user.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/users/${user.id}/clear-login-failures`, {
          method: 'POST',
          token: authToken
        });
        showSuccess(data.message || `Login destrabado para ${username}`);
      } catch (err) {
        showError(err.message || 'Error al destrabar login');
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
      showSuccess('Usuario eliminado exitosamente.');
      await reloadUsers();
    } catch (error) {
      console.error('Error al eliminar usuario:', error);
      setError(error.message || 'Error al eliminar usuario.');
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
        setEditingUser((prev) => (prev && prev.id === data.user.id ? data.user : prev));
      } catch (err) {
        showError(err.message || 'Error al guardar permisos del usuario');
      }
    });
  };

  if (!hasPermission(currentUser, 'users.view')) return null;

  const rangeFrom = filteredUsers.length === 0 ? 0 : safePage * pageSize + 1;
  const rangeTo = Math.min(filteredUsers.length, (safePage + 1) * pageSize);

  return (
    <div className="users-admin">
      <AdminBlock
        title={<><Users size={18} /> Usuarios</>}
        description="Buscá, filtrá y administrá cuentas sin desplazarte por tarjetas."
        action={canCreate ? (
          <button
            type="button"
            className={`btn btn-primary users-admin__create-toggle${createOpen ? ' is-open' : ''}`}
            onClick={() => setCreateOpen((v) => !v)}
          >
            {createOpen ? <X size={16} /> : <UserPlus size={16} />}
            {createOpen ? 'Cerrar' : 'Nuevo usuario'}
          </button>
        ) : null}
      >
        {canCreate && createOpen && (
          <form onSubmit={handleCreateUser} className="users-admin__create">
            <input
              type="text"
              id="newUsername"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="input-field"
              placeholder="Usuario / email"
              required
              autoFocus
            />
            <input
              type="password"
              id="newUserPassword"
              value={newUserPassword}
              onChange={(e) => setNewUserPassword(e.target.value)}
              className="input-field"
              placeholder="Contraseña"
              required
            />
            <select
              id="newUserRole"
              value={newUserRole}
              onChange={(e) => setNewUserRole(e.target.value)}
              className="input-field"
            >
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.id}>{role.label}</option>
              ))}
            </select>
            <PendingButton
              type="submit"
              actionId="createUser"
              pendingAction={pendingAction}
              className="btn btn-primary"
              pendingLabel="Creando…"
            >
              <PlusCircle size={18} /> Crear
            </PendingButton>
          </form>
        )}

        <div className="users-admin__stats" aria-label="Resumen de usuarios">
          <span className="users-admin__stat"><strong>{stats.total}</strong> usuarios</span>
          <span className="users-admin__stat users-admin__stat--ok"><strong>{stats.active}</strong> activos</span>
          <span className="users-admin__stat users-admin__stat--muted"><strong>{stats.inactive}</strong> inactivos</span>
          <span className="users-admin__stat"><strong>{stats.customPerms}</strong> con permisos extra</span>
          {stats.stations > 0 ? (
            <span className="users-admin__stat" title="Cuentas técnicas de lectores; se administran en Lectores">
              <strong>{stats.stations}</strong> estaciones de acceso
            </span>
          ) : null}
        </div>

        <div className="users-admin__toolbar">
          <label className="users-admin__search">
            <Search size={16} aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar usuario, email o rol…"
              aria-label="Buscar usuarios"
            />
          </label>
          <label className="users-admin__filter">
            <Filter size={14} aria-hidden />
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              aria-label="Filtrar por rol"
            >
              <option value="all">Todos los roles</option>
              {roleOptions.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </label>
          <label className="users-admin__filter">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filtrar por estado"
            >
              <option value="all">Todos los estados</option>
              <option value="active">Solo activos</option>
              <option value="inactive">Solo inactivos</option>
            </select>
          </label>
          {stats.stations > 0 ? (
            <label className="users-admin__toggle-stations">
              <input
                type="checkbox"
                checked={showAccessStations}
                onChange={(e) => setShowAccessStations(e.target.checked)}
              />
              Mostrar {ACCESS_STATION_ROLE_LABEL.toLowerCase()}
            </label>
          ) : null}
          {hasActiveFilters && (
            <button type="button" className="btn btn-secondary-small" onClick={clearFilters}>
              <X size={14} /> Limpiar
            </button>
          )}
        </div>

        {loading ? (
          <AdminLoading label="Cargando usuarios…" />
        ) : humanUsers.length === 0 && !showAccessStations ? (
          <AdminEmpty
            icon={Users}
            title="Todavía no hay usuarios"
            description={stats.stations > 0
              ? `Hay ${stats.stations} estación(es) de acceso; se gestionan en Lectores. Activá “Mostrar estación de acceso” si necesitás verlas acá.`
              : 'Creá el primero con «Nuevo usuario».'}
          />
        ) : users.length === 0 ? (
          <AdminEmpty
            icon={Users}
            title="Todavía no hay usuarios"
            description="Creá el primero con «Nuevo usuario»."
          />
        ) : filteredUsers.length === 0 ? (
          <AdminEmpty
            icon={Search}
            title="Sin coincidencias"
            description="Probá otro texto o quitá los filtros."
          />
        ) : (
          <>
            <AdminTable className="users-admin__table">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>Permisos</th>
                  <th className="users-admin__th-actions">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {pageSlice.map((user) => {
                  const customCount = (user.customPermissions || []).length;
                  const manageable = canManageTargetUser(currentUser, user);
                  return (
                    <tr key={user.id} className={`${user.active === false ? 'users-admin__row--inactive' : ''}${isAccessStationAccount(user) ? ' users-admin__row--station' : ''}`}>
                      <td>
                        <div className="users-admin__user-cell">
                          <span className="users-admin__username">{user.username}</span>
                          {isAccessStationAccount(user) ? (
                            <span className="users-admin__chip" title="Cuenta técnica del lector físico">
                              {ACCESS_STATION_ROLE_LABEL}
                            </span>
                          ) : null}
                          {user.mustChangePassword ? (
                            <span className="users-admin__chip users-admin__chip--warn">Cambio pass</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <span className="users-admin__role">{roleLabel(systemRoles, user.role)}</span>
                      </td>
                      <td>
                        <span className={`users-admin__status${user.active !== false ? ' is-active' : ' is-inactive'}`}>
                          {user.active !== false ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td>
                        {customCount > 0 ? (
                          <span className="users-admin__chip" title={`${customCount} permiso(s) personalizado(s)`}>
                            {customCount} extra
                          </span>
                        ) : (
                          <span className="users-admin__muted">Rol</span>
                        )}
                      </td>
                      <td>
                        <div className="users-admin__actions">
                          {canEdit && manageable && (
                            <button
                              type="button"
                              className="users-admin__icon-btn"
                              onClick={() => handleEditUser(user)}
                              title="Editar"
                              aria-label={`Editar ${user.username}`}
                            >
                              <Edit size={15} />
                            </button>
                          )}
                          {canUnlock && (
                            <button
                              type="button"
                              className="users-admin__icon-btn"
                              onClick={() => handleClearLoginFailures(user)}
                              title="Destrabar login"
                              aria-label={`Destrabar login de ${user.username}`}
                            >
                              <Unlock size={15} />
                            </button>
                          )}
                          {canDelete && user.id !== currentUser.id && manageable && (
                            <button
                              type="button"
                              className="users-admin__icon-btn users-admin__icon-btn--danger"
                              onClick={() => handleDeleteUser(user.id)}
                              title="Eliminar"
                              aria-label={`Eliminar ${user.username}`}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </AdminTable>

            <div className="users-admin__pager">
              <span className="users-admin__pager-meta">
                {rangeFrom}–{rangeTo} de {filteredUsers.length}
                {filteredUsers.length !== visibleUsers.length ? ` (filtrados de ${visibleUsers.length})` : ''}
                {!showAccessStations && stats.stations > 0
                  ? ` · ${stats.stations} estación(es) oculta(s) — ver en Lectores`
                  : ''}
              </span>
              <label className="users-admin__page-size">
                Por página
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  aria-label="Cantidad por página"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <div className="users-admin__pager-btns">
                <button
                  type="button"
                  className="btn btn-secondary-small"
                  disabled={safePage <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  aria-label="Página anterior"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="users-admin__page-num">{safePage + 1} / {pageCount}</span>
                <button
                  type="button"
                  className="btn btn-secondary-small"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  aria-label="Página siguiente"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </AdminBlock>

      {editingUser && (
        <div className="modal-overlay">
          <div className="modal-content max-w-2xl">
            <button type="button" className="close-button" onClick={() => setEditingUser(null)} aria-label="Cerrar">
              <XCircle size={24} />
            </button>
            <h3 className="admin-block__title" style={{ marginBottom: '1rem' }}>
              Editar usuario: {editingUser.username}
            </h3>
            <form onSubmit={handleSaveUserEdit} className="space-y-4">
              <input type="text" id="editedUsername" value={editedUsername} className="input-field" disabled />
              {canEdit && canManageTargetUser(currentUser, editingUser) && (
                <select
                  id="editedUserRole"
                  value={editedUserRole}
                  onChange={(e) => setEditedUserRole(e.target.value)}
                  className="input-field"
                  disabled={editingUser.id === currentUser.id}
                >
                  {assignableRoles.map((role) => (
                    <option key={role.id} value={role.id}>{role.label}</option>
                  ))}
                </select>
              )}
              <input
                type="password"
                id="editedUserPassword"
                value={editedUserPassword}
                onChange={(e) => setEditedUserPassword(e.target.value)}
                className="input-field"
                placeholder="Nueva contraseña (opcional)"
              />
              {canEdit && canManageTargetUser(currentUser, editingUser) && (
                <button
                  type="button"
                  onClick={() => setEditedUserActive(!editedUserActive)}
                  className={`admin-toggle-active${editedUserActive ? ' is-on' : ''}`}
                  disabled={editingUser.id === currentUser.id}
                >
                  {editedUserActive ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                  {' '}
                  {editedUserActive ? 'Activo' : 'Inactivo'}
                </button>
              )}
              {canPerms && (
                <div>
                  <h4 className="admin-block__title" style={{ marginBottom: '0.5rem' }}>Permisos personalizados</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto border rounded-md p-3">
                    {(permissionKeys.length ? permissionKeys : Object.keys(PERMISSION_LABELS)).map((permission) => (
                      <label key={permission} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={editingUserPermissions.includes(permission)}
                          onChange={() => toggleEditingUserPermission(permission)}
                        />
                        {PERMISSION_LABELS[permission] || permission}
                      </label>
                    ))}
                  </div>
                  <PendingButton
                    type="button"
                    actionId="saveUserPermissions"
                    pendingAction={pendingAction}
                    className="btn btn-secondary mt-3"
                    pendingLabel="Guardando..."
                    onClick={handleSaveUserPermissions}
                  >
                    Guardar permisos personalizados
                  </PendingButton>
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setEditingUser(null)} className="btn btn-secondary">
                  <XCircle size={20} /> Cancelar
                </button>
                <PendingButton
                  type="submit"
                  actionId="saveUserEdit"
                  pendingAction={pendingAction}
                  className="btn btn-primary"
                  pendingLabel="Guardando..."
                >
                  <Save size={20} /> Guardar cambios
                </PendingButton>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default UsersAdminSection;
