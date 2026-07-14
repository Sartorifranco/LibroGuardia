import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit, Eye, EyeOff, Loader2, PlusCircle, Save, Shield, Trash2 } from 'lucide-react';
import {
  DASHBOARD_PROFILE_LABELS,
  PERMISSION_LABELS,
  ROLE_TEMPLATES,
  buildPermissionCategories,
  hasPermission,
  slugifyRoleId
} from '../utils/permissions';
import { useConfirm } from '../context/ConfirmContext';
import { apiFetch } from '../services/api';

const TEMPLATE_ORDER = ['guardia', 'supervisor', 'monitoreo', 'admin'];

function countActiveInCategory(permissions, categoryPerms) {
  const set = new Set(permissions || []);
  return categoryPerms.filter((p) => set.has(p)).length;
}

function RolePermissionEditor({
  role,
  permissionKeys,
  categories,
  canManage,
  showAdvanced,
  onToggleAdvanced,
  onTogglePermission,
  onSetCategory,
  onChangeMeta,
  showMeta = true
}) {
  const active = role.permissions || [];

  return (
    <div className="roles-perm-editor">
      {showMeta && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <input
            className="input-field"
            value={role.label}
            onChange={(e) => onChangeMeta({ label: e.target.value })}
            disabled={!canManage}
          />
          <select
            className="input-field bg-white"
            value={role.dashboardProfile}
            onChange={(e) => onChangeMeta({ dashboardProfile: e.target.value })}
            disabled={
              !canManage ||
              (role.isSystem && ['admin', 'supervisor', 'guardia', 'monitoreo'].includes(role.id))
            }
          >
            {Object.entries(DASHBOARD_PROFILE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <input
            className="input-field md:col-span-2"
            value={role.description || ''}
            onChange={(e) => onChangeMeta({ description: e.target.value })}
            disabled={!canManage}
            placeholder="Descripción"
          />
        </div>
      )}

      {!showAdvanced ? (
        <div className="roles-perm-categories">
          {categories.map((cat) => {
            const activeCount = countActiveInCategory(active, cat.permissions);
            const total = cat.permissions.length;
            const allOn = activeCount === total;
            return (
              <div key={cat.id} className="roles-perm-category">
                <div className="roles-perm-category__header">
                  <div>
                    <p className="roles-perm-category__title">{cat.label}</p>
                    <p className="roles-perm-category__count">
                      {activeCount} de {total} permisos activos
                    </p>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      className={`btn btn-secondary-small${allOn ? ' roles-perm-category__toggle--on' : ''}`}
                      onClick={() => onSetCategory(cat.permissions, !allOn)}
                    >
                      {allOn ? 'Desactivar todo' : 'Activar todo'}
                    </button>
                  )}
                </div>
                <ul className="roles-perm-category__list">
                  {cat.permissions.map((permission) => (
                    <li key={permission}>
                      <label className="roles-perm-item">
                        <input
                          type="checkbox"
                          checked={active.includes(permission)}
                          onChange={() => onTogglePermission(permission)}
                          disabled={!canManage}
                        />
                        <span>{PERMISSION_LABELS[permission] || permission}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="roles-perm-advanced grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
          {permissionKeys.map((permission) => (
            <label key={permission} className="roles-perm-item">
              <input
                type="checkbox"
                checked={active.includes(permission)}
                onChange={() => onTogglePermission(permission)}
                disabled={!canManage}
              />
              <span>{PERMISSION_LABELS[permission] || permission}</span>
            </label>
          ))}
        </div>
      )}

      <button
        type="button"
        className="btn btn-secondary-small roles-perm-advanced-toggle"
        onClick={onToggleAdvanced}
      >
        {showAdvanced ? <EyeOff size={16} /> : <Eye size={16} />}
        {showAdvanced ? 'Vista por categorías' : 'Ver permisos individuales (avanzado)'}
      </button>
    </div>
  );
}

function RolesAdminPanel({ authToken, currentUser, onSuccess, onError }) {
  const { confirm } = useConfirm();
  const [roles, setRoles] = useState([]);
  const [permissionKeys, setPermissionKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newRoleLabel, setNewRoleLabel] = useState('');
  const [newRoleDescription, setNewRoleDescription] = useState('');
  const [newRoleProfile, setNewRoleProfile] = useState('operational');
  const [newRolePermissions, setNewRolePermissions] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [editingRole, setEditingRole] = useState(null);
  const [advancedByRole, setAdvancedByRole] = useState({});
  const [createAdvanced, setCreateAdvanced] = useState(false);
  const [showCreatePerms, setShowCreatePerms] = useState(false);

  const canManage = hasPermission(currentUser, 'roles.manage');
  const generatedId = slugifyRoleId(newRoleLabel);

  const categories = useMemo(
    () => buildPermissionCategories(permissionKeys.length ? permissionKeys : Object.keys(PERMISSION_LABELS)),
    [permissionKeys]
  );

  const loadRoles = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const data = await apiFetch('/admin/roles', { token: authToken, allowForbidden: true });
      setRoles(data.roles || []);
      setPermissionKeys(data.permissionKeys || Object.keys(PERMISSION_LABELS));
    } catch (err) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  }, [authToken, onError]);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const applyTemplate = (templateId) => {
    const template = ROLE_TEMPLATES[templateId];
    if (!template) return;
    setSelectedTemplate(templateId);
    setNewRoleLabel(`${template.label} personalizado`);
    setNewRoleDescription(template.description);
    setNewRoleProfile(template.dashboardProfile);
    setNewRolePermissions([...template.permissions]);
    setShowCreatePerms(true);
  };

  const resetCreateForm = () => {
    setNewRoleLabel('');
    setNewRoleDescription('');
    setNewRoleProfile('operational');
    setNewRolePermissions([]);
    setSelectedTemplate(null);
    setShowCreatePerms(false);
    setCreateAdvanced(false);
  };

  const handleCreateRole = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    if (!generatedId) {
      onError?.('Ingresá un nombre válido para el rol.');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/admin/roles', {
        method: 'POST',
        token: authToken,
        body: {
          id: generatedId,
          label: newRoleLabel.trim(),
          description: newRoleDescription,
          dashboardProfile: newRoleProfile,
          permissions: newRolePermissions
        }
      });
      onSuccess?.('Rol creado correctamente.');
      resetCreateForm();
      loadRoles();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateRoleLocal = (roleId, patch) => {
    setRoles((prev) => prev.map((role) => (role.id === roleId ? { ...role, ...patch } : role)));
  };

  const togglePermission = (roleId, permission) => {
    if (!canManage) return;
    setRoles((prev) => prev.map((role) => {
      if (role.id !== roleId) return role;
      const current = role.permissions || [];
      const next = current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission];
      return { ...role, permissions: next };
    }));
  };

  const setCategoryPermissions = (roleId, categoryPerms, enable) => {
    if (!canManage) return;
    setRoles((prev) => prev.map((role) => {
      if (role.id !== roleId) return role;
      const current = new Set(role.permissions || []);
      categoryPerms.forEach((p) => {
        if (enable) current.add(p);
        else current.delete(p);
      });
      return { ...role, permissions: [...current] };
    }));
  };

  const toggleCreatePermission = (permission) => {
    setNewRolePermissions((prev) => (
      prev.includes(permission)
        ? prev.filter((p) => p !== permission)
        : [...prev, permission]
    ));
  };

  const setCreateCategory = (categoryPerms, enable) => {
    setNewRolePermissions((prev) => {
      const next = new Set(prev);
      categoryPerms.forEach((p) => {
        if (enable) next.add(p);
        else next.delete(p);
      });
      return [...next];
    });
  };

  const saveRole = async (role) => {
    if (!canManage) return;
    setSaving(true);
    try {
      await apiFetch(`/admin/roles/${role.id}`, {
        method: 'PUT',
        token: authToken,
        body: {
          label: role.label,
          description: role.description,
          dashboardProfile: role.dashboardProfile,
          permissions: role.permissions
        }
      });
      onSuccess?.(`Rol ${role.label} actualizado.`);
      setEditingRole(null);
      loadRoles();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async (role) => {
    if (!canManage || role.isSystem) return;
    const ok = await confirm({
      title: 'Eliminar rol',
      message: `Se eliminará el rol "${role.label}". Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    setSaving(true);
    try {
      await apiFetch(`/admin/roles/${role.id}`, {
        method: 'DELETE',
        token: authToken
      });
      onSuccess?.('Rol eliminado.');
      loadRoles();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <p className="text-gray-500 flex items-center gap-2">
        <Loader2 className="animate-spin" size={18} /> Cargando roles...
      </p>
    );
  }

  const createDraftRole = {
    id: generatedId || 'nuevo',
    label: newRoleLabel,
    description: newRoleDescription,
    dashboardProfile: newRoleProfile,
    permissions: newRolePermissions,
    isSystem: false
  };

  return (
    <div className="roles-admin-panel">
      {canManage && (
        <section className="admin-sub-section">
          <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2">
            <PlusCircle size={20} /> Crear rol
          </h3>

          <div className="roles-templates">
            <p className="roles-templates__label">Plantillas rápidas</p>
            <div className="roles-templates__row">
              {TEMPLATE_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`btn btn-secondary-small${selectedTemplate === id ? ' roles-templates__btn--active' : ''}`}
                  onClick={() => applyTemplate(id)}
                >
                  {ROLE_TEMPLATES[id].label}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleCreateRole} className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <div className="md:col-span-2">
              <input
                className="input-field"
                placeholder="Nombre del rol"
                value={newRoleLabel}
                onChange={(e) => setNewRoleLabel(e.target.value)}
                required
              />
              <p className="roles-generated-id">
                ID técnico: <code>{generatedId || '—'}</code>
                <span className="roles-generated-id__hint"> (se genera automáticamente)</span>
              </p>
            </div>
            <input
              className="input-field md:col-span-2"
              placeholder="Descripción"
              value={newRoleDescription}
              onChange={(e) => setNewRoleDescription(e.target.value)}
            />
            <select
              className="input-field bg-white"
              value={newRoleProfile}
              onChange={(e) => setNewRoleProfile(e.target.value)}
            >
              {Object.entries(DASHBOARD_PROFILE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowCreatePerms((v) => !v)}
              >
                {showCreatePerms ? 'Ocultar permisos' : `Permisos (${newRolePermissions.length})`}
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || !generatedId}>
                {saving ? 'Creando...' : 'Crear rol'}
              </button>
            </div>
          </form>

          {showCreatePerms && (
            <div className="mt-4">
              <RolePermissionEditor
                role={createDraftRole}
                permissionKeys={permissionKeys}
                categories={categories}
                canManage={canManage}
                showAdvanced={createAdvanced}
                showMeta={false}
                onToggleAdvanced={() => setCreateAdvanced((v) => !v)}
                onTogglePermission={toggleCreatePermission}
                onSetCategory={setCreateCategory}
                onChangeMeta={() => {}}
              />
            </div>
          )}
        </section>
      )}

      <section className="admin-sub-section">
        <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2">
          <Shield size={20} /> Roles del sistema
        </h3>
        <div className="space-y-4">
          {roles.map((role) => (
            <article key={role.id} className="user-list-item flex-col items-stretch">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-gray-900">{role.label}</p>
                  <p className="text-sm text-gray-600">
                    ID: {role.id} · Pantalla: {DASHBOARD_PROFILE_LABELS[role.dashboardProfile] || role.dashboardProfile}
                    {role.isSystem ? ' · Rol del sistema' : ''}
                    {' · '}{(role.permissions || []).length} permisos
                  </p>
                  {role.description && <p className="text-sm text-gray-500 mt-1">{role.description}</p>}
                </div>
                <div className="flex gap-2">
                  {canManage && (
                    <button
                      type="button"
                      className="btn btn-secondary-small"
                      onClick={() => setEditingRole(editingRole === role.id ? null : role.id)}
                    >
                      <Edit size={16} /> {editingRole === role.id ? 'Cerrar' : 'Permisos'}
                    </button>
                  )}
                  {canManage && !role.isSystem && (
                    <button type="button" className="btn btn-danger-small" onClick={() => deleteRole(role)}>
                      <Trash2 size={16} /> Eliminar
                    </button>
                  )}
                </div>
              </div>

              {editingRole === role.id && canManage && (
                <div className="mt-4 border-t pt-4">
                  <RolePermissionEditor
                    role={role}
                    permissionKeys={permissionKeys}
                    categories={categories}
                    canManage={canManage}
                    showAdvanced={Boolean(advancedByRole[role.id])}
                    onToggleAdvanced={() => setAdvancedByRole((prev) => ({
                      ...prev,
                      [role.id]: !prev[role.id]
                    }))}
                    onTogglePermission={(permission) => togglePermission(role.id, permission)}
                    onSetCategory={(perms, enable) => setCategoryPermissions(role.id, perms, enable)}
                    onChangeMeta={(patch) => updateRoleLocal(role.id, patch)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary mt-4"
                    disabled={saving}
                    onClick={() => saveRole(role)}
                  >
                    <Save size={16} /> Guardar rol
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default RolesAdminPanel;
