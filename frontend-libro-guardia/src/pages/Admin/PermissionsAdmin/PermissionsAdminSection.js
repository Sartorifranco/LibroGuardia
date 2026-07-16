import React, { useEffect, useMemo, useState } from 'react';
import { Save, Loader2 } from 'lucide-react';
import PendingButton from '../../../components/PendingButton';
import { hasPermission, PERMISSION_LABELS } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';

/**
 * Sección "Permisos por rol" del panel de administración.
 * @param {{ pendingAction: string|null, runAction: Function, onPermissionKeysChange?: (keys: string[]) => void }} props
 */
function PermissionsAdminSection({ pendingAction, runAction, onPermissionKeysChange }) {
  const { authToken, currentUser, systemRoles, setSystemRoles } = useAuth();
  const { showSuccess, showError } = useToast();

  const [loading, setLoading] = useState(false);
  const [rolePermissions, setRolePermissions] = useState({});
  const [permissionKeys, setPermissionKeys] = useState([]);

  useEffect(() => {
    const fetchRolePermissions = async () => {
      if (!currentUser || !hasPermission(currentUser, 'settings.permissions')) return;
      setLoading(true);
      try {
        const data = await apiFetch('/admin/roles', { token: authToken, allowForbidden: true });
        const rolesMap = {};
        (data.roles || []).forEach((role) => {
          rolesMap[role.id] = role.permissions || [];
        });
        setRolePermissions(rolesMap);
        setSystemRoles(data.roles || []);
        setPermissionKeys(data.permissionKeys || []);
        onPermissionKeysChange?.(data.permissionKeys || []);
      } catch (err) {
        console.error('Error al cargar permisos por rol:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchRolePermissions();
  }, [currentUser, authToken]);

  const toggleRolePermission = (role, permission) => {
    setRolePermissions((prev) => {
      const current = prev[role] || [];
      const exists = current.includes(permission);
      const updated = exists ? current.filter((item) => item !== permission) : [...current, permission];
      return { ...prev, [role]: updated };
    });
  };

  const handleSaveRolePermissions = async () => {
    await runAction('saveRolePermissions', async () => {
      try {
        await apiFetch('/admin/permissions/roles', {
          method: 'PUT',
          token: authToken,
          body: { roles: rolePermissions }
        });
        showSuccess('Permisos por rol actualizados.');
      } catch (err) {
        showError(err.message || 'Error al guardar permisos');
      }
    });
  };

  const permissionMatrixRoles = useMemo(() => {
    if (systemRoles.length) return systemRoles;
    return Object.keys(rolePermissions).map((id) => ({ id, label: id }));
  }, [systemRoles, rolePermissions]);

  if (!hasPermission(currentUser, 'settings.permissions')) return null;

  return (
    <div className="admin-sub-section">
      <h3 className="text-xl font-medium text-gray-800 mb-3">Permisos por rol</h3>

      {loading && (
        <div className="admin-section-loading">
          <Loader2 className="animate-spin" size={32} />
          <span>Cargando sección…</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-100">
            <tr>
              <th className="px-4 py-2 text-left text-xs uppercase">Permiso</th>
              {permissionMatrixRoles.map((role) => (
                <th key={role.id} className="px-4 py-2 text-center text-xs uppercase">{role.label || role.id}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(permissionKeys.length ? permissionKeys : Object.keys(PERMISSION_LABELS)).map((permission) => (
              <tr key={permission} className="border-t">
                <td className="px-4 py-2 text-sm">{PERMISSION_LABELS[permission] || permission}</td>
                {permissionMatrixRoles.map((role) => (
                  <td key={role.id} className="px-4 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={(rolePermissions[role.id] || []).includes(permission)}
                      onChange={() => toggleRolePermission(role.id, permission)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PendingButton type="button" actionId="saveRolePermissions" pendingAction={pendingAction} className="btn btn-primary mt-4" pendingLabel="Guardando permisos..." onClick={handleSaveRolePermissions}>
        <Save size={18} /> Guardar permisos por rol
      </PendingButton>
    </div>
  );
}

export default PermissionsAdminSection;
