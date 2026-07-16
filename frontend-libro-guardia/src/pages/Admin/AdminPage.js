import React, { useEffect, useMemo, useState } from 'react';
import { Car, ClipboardList, Settings, KeyRound, Truck, ShieldCheck, QrCode, DoorOpen, Activity, Loader2 } from 'lucide-react';
import { hasPermission } from '../../utils/permissions';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../services/api';
import { ADMIN_SECTION_META } from './adminConstants';
import { useAdminAction } from './hooks/useAdminAction';
import UsersAdminSection from './UsersAdmin/UsersAdminSection';
import CitacionesAdminSection from './CitacionesAdmin/CitacionesAdminSection';
import AccessGpsAdminSection from './AccessGpsAdmin/AccessGpsAdminSection';
import NominaAdminSection from './NominaAdmin/NominaAdminSection';
import VehiclesAdminSection from './VehiclesAdmin/VehiclesAdminSection';
import FleetAdminSection from './FleetAdmin/FleetAdminSection';
import PermissionsAdminSection from './PermissionsAdmin/PermissionsAdminSection';
import DoorsAdminSection from './DoorsAdmin/DoorsAdminSection';
import RolesAdminSection from './RolesAdmin/RolesAdminSection';
import ActivityAdminSection from './ActivityAdmin/ActivityAdminSection';

/**
 * Panel de administración completo.
 * @param {{ adminSection: string, onSectionChange: (id: string) => void, onExit?: () => void, onAccessConfigSaved?: (cfg: object) => void }} props
 */
function AdminPage({ adminSection, onSectionChange, onExit, onAccessConfigSaved, authPrefillKey = 0 }) {
  void onExit;
  const { authToken, currentUser } = useAuth();
  const { pendingAction, setPendingAction, runAction } = useAdminAction();
  const setAdminSection = onSectionChange;

  // Compartido entre la sección de Usuarios (modal de edición) y la de Permisos.
  const [permissionKeys, setPermissionKeys] = useState([]);

  // Mismo prefetch que el AdminPage monolítico: al abrir Admin (no solo la pestaña Puertas).
  useEffect(() => {
    const fetchKioskSettings = async () => {
      if (!currentUser || !hasPermission(currentUser, 'access.kiosk')) return;
      try {
        const data = await apiFetch('/admin/access-control', { token: authToken, allowForbidden: true });
        if (data?.config) onAccessConfigSaved?.(data.config);
      } catch (err) {
        console.error('Error al cargar ajustes del molinete:', err);
      }
    };
    if (currentUser) fetchKioskSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- igual que antes: no re-correr por cambios de callback
  }, [currentUser, authToken]);

  const adminNavItems = useMemo(() => {
    if (!currentUser) return [];
    const items = [];
    if (hasPermission(currentUser, 'users.view')) items.push({ id: 'users', label: 'Usuarios', icon: KeyRound });
    if (hasPermission(currentUser, 'roles.view') || hasPermission(currentUser, 'roles.manage')) {
      items.push({ id: 'roles', label: 'Roles', icon: ShieldCheck });
    }
    if (
      hasPermission(currentUser, 'users.view') ||
      hasPermission(currentUser, 'roles.view') ||
      hasPermission(currentUser, 'settings.permissions')
    ) {
      items.push({ id: 'activity', label: 'Actividad', icon: Activity });
    }
    if (hasPermission(currentUser, 'access.doors.manage') || hasPermission(currentUser, 'access.control')) {
      items.push({ id: 'doors', label: 'Puertas y acceso', icon: DoorOpen });
    }
    if (hasPermission(currentUser, 'access.control')) items.push({ id: 'access', label: 'GPS flota', icon: ShieldCheck });
    if (hasPermission(currentUser, 'master.citaciones.write')) items.push({ id: 'citaciones', label: 'Autorizaciones', icon: QrCode });
    if (hasPermission(currentUser, 'master.nomina.write')) items.push({ id: 'nomina', label: 'Nómina', icon: ClipboardList });
    if (hasPermission(currentUser, 'master.vehicles.write')) items.push({ id: 'vehicles', label: 'Vehículos', icon: Car });
    if (hasPermission(currentUser, 'fleet.upload')) items.push({ id: 'fleet', label: 'Flota interna', icon: Truck });
    if (hasPermission(currentUser, 'settings.permissions')) items.push({ id: 'permissions', label: 'Permisos', icon: Settings });
    return items;
  }, [currentUser]);

  const activeAdminMeta = ADMIN_SECTION_META[adminSection] || { title: 'Administración', description: '' };

  return (
    <>
      <div className="admin-panel">
        <div className="admin-panel-top">
          <div>
            <span className="admin-panel-badge"><Settings size={12} /> Administración</span>
            <h2>Panel de control</h2>
            <p>Configuración avanzada del Libro de Guardia — solo personal autorizado.</p>
          </div>
          {pendingAction && (
            <div className="admin-action-indicator">
              <Loader2 className="animate-spin" size={18} />
              <span>Acción en curso…</span>
            </div>
          )}
        </div>

        <div className="admin-panel-layout">
          <aside className="admin-sidebar" aria-label="Secciones de administración">
            {adminNavItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`admin-sidebar-btn${adminSection === id ? ' active' : ''}`}
                onClick={() => setAdminSection(id)}
              >
                <Icon size={18} aria-hidden />
                {label}
              </button>
            ))}
          </aside>

          <div className="admin-content">
            <div className="admin-content-header">
              <h3>{activeAdminMeta.title}</h3>
              <p>{activeAdminMeta.description}</p>
            </div>

            {adminSection === 'users' && hasPermission(currentUser, 'users.view') && (
              <UsersAdminSection pendingAction={pendingAction} runAction={runAction} permissionKeys={permissionKeys} />
            )}

            {adminSection === 'citaciones' && hasPermission(currentUser, 'master.citaciones.write') && (
              <CitacionesAdminSection
                pendingAction={pendingAction}
                runAction={runAction}
                setPendingAction={setPendingAction}
                authPrefillKey={authPrefillKey}
              />
            )}

            {adminSection === 'doors' && (hasPermission(currentUser, 'access.doors.manage') || hasPermission(currentUser, 'access.control')) && (
              <DoorsAdminSection pendingAction={pendingAction} runAction={runAction} onAccessConfigSaved={onAccessConfigSaved} />
            )}

            {adminSection === 'access' && hasPermission(currentUser, 'access.control') && (
              <AccessGpsAdminSection pendingAction={pendingAction} runAction={runAction} />
            )}

            {adminSection === 'nomina' && hasPermission(currentUser, 'master.nomina.write') && (
              <NominaAdminSection pendingAction={pendingAction} setPendingAction={setPendingAction} />
            )}

            {adminSection === 'vehicles' && hasPermission(currentUser, 'master.vehicles.write') && (
              <VehiclesAdminSection pendingAction={pendingAction} runAction={runAction} setPendingAction={setPendingAction} />
            )}

            {adminSection === 'fleet' && hasPermission(currentUser, 'fleet.upload') && (
              <FleetAdminSection pendingAction={pendingAction} setPendingAction={setPendingAction} />
            )}

            {adminSection === 'roles' && (hasPermission(currentUser, 'roles.view') || hasPermission(currentUser, 'roles.manage')) && (
              <RolesAdminSection />
            )}

            {adminSection === 'activity'
              && (hasPermission(currentUser, 'users.view')
                || hasPermission(currentUser, 'roles.view')
                || hasPermission(currentUser, 'settings.permissions'))
              && (
                <ActivityAdminSection />
              )}

            {adminSection === 'permissions' && hasPermission(currentUser, 'settings.permissions') && (
              <PermissionsAdminSection pendingAction={pendingAction} runAction={runAction} onPermissionKeysChange={setPermissionKeys} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default AdminPage;
