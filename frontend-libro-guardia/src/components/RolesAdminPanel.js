import React, { useCallback, useEffect, useState } from 'react';
import { Edit, Loader2, PlusCircle, Save, Shield, Trash2 } from 'lucide-react';
import {
  DASHBOARD_PROFILE_LABELS,
  PERMISSION_LABELS,
  hasPermission
} from '../utils/permissions';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

function RolesAdminPanel({ authToken, currentUser, onSuccess, onError }) {
  const [roles, setRoles] = useState([]);
  const [permissionKeys, setPermissionKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newRoleId, setNewRoleId] = useState('');
  const [newRoleLabel, setNewRoleLabel] = useState('');
  const [newRoleDescription, setNewRoleDescription] = useState('');
  const [newRoleProfile, setNewRoleProfile] = useState('operational');
  const [editingRole, setEditingRole] = useState(null);

  const canManage = hasPermission(currentUser, 'roles.manage');

  const loadRoles = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/roles`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al cargar roles');
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

  const handleCreateRole = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/roles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          id: newRoleId,
          label: newRoleLabel,
          description: newRoleDescription,
          dashboardProfile: newRoleProfile,
          permissions: []
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al crear rol');
      onSuccess?.('Rol creado correctamente.');
      setNewRoleId('');
      setNewRoleLabel('');
      setNewRoleDescription('');
      setNewRoleProfile('operational');
      loadRoles();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSaving(false);
    }
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

  const saveRole = async (role) => {
    if (!canManage) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/roles/${role.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          label: role.label,
          description: role.description,
          dashboardProfile: role.dashboardProfile,
          permissions: role.permissions
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al guardar rol');
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
    if (!window.confirm(`¿Eliminar el rol "${role.label}"?`)) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/roles/${role.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al eliminar rol');
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

  return (
    <div className="roles-admin-panel">
      {canManage && (
        <section className="admin-sub-section">
          <h3 className="text-xl font-medium text-gray-800 mb-3 flex items-center gap-2">
            <PlusCircle size={20} /> Crear rol
          </h3>
          <form onSubmit={handleCreateRole} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="input-field" placeholder="Identificador (ej: turno_noche)" value={newRoleId} onChange={(e) => setNewRoleId(e.target.value)} required />
            <input className="input-field" placeholder="Nombre visible" value={newRoleLabel} onChange={(e) => setNewRoleLabel(e.target.value)} required />
            <input className="input-field md:col-span-2" placeholder="Descripción" value={newRoleDescription} onChange={(e) => setNewRoleDescription(e.target.value)} />
            <select className="input-field bg-white" value={newRoleProfile} onChange={(e) => setNewRoleProfile(e.target.value)}>
              {Object.entries(DASHBOARD_PROFILE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creando...' : 'Crear rol'}
            </button>
          </form>
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
                  </p>
                  {role.description && <p className="text-sm text-gray-500 mt-1">{role.description}</p>}
                </div>
                <div className="flex gap-2">
                  {canManage && (
                    <button type="button" className="btn btn-secondary-small" onClick={() => setEditingRole(editingRole === role.id ? null : role.id)}>
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                    <input
                      className="input-field"
                      value={role.label}
                      onChange={(e) => setRoles((prev) => prev.map((item) => item.id === role.id ? { ...item, label: e.target.value } : item))}
                    />
                    <select
                      className="input-field bg-white"
                      value={role.dashboardProfile}
                      onChange={(e) => setRoles((prev) => prev.map((item) => item.id === role.id ? { ...item, dashboardProfile: e.target.value } : item))}
                      disabled={role.isSystem && ['admin', 'supervisor', 'guardia', 'monitoreo'].includes(role.id)}
                    >
                      {Object.entries(DASHBOARD_PROFILE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    <input
                      className="input-field md:col-span-2"
                      value={role.description || ''}
                      onChange={(e) => setRoles((prev) => prev.map((item) => item.id === role.id ? { ...item, description: e.target.value } : item))}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                    {permissionKeys.map((permission) => (
                      <label key={permission} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={(role.permissions || []).includes(permission)}
                          onChange={() => togglePermission(role.id, permission)}
                        />
                        <span>{PERMISSION_LABELS[permission] || permission}</span>
                      </label>
                    ))}
                  </div>
                  <button type="button" className="btn btn-primary mt-4" disabled={saving} onClick={() => saveRole(role)}>
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
