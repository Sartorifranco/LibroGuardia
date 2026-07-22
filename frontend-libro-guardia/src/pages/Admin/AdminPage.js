import React, { useEffect, useMemo, useState } from 'react';
import {
  Car,
  ClipboardList,
  Settings,
  KeyRound,
  Truck,
  ShieldCheck,
  QrCode,
  DoorOpen,
  Activity,
  Loader2,
  ScrollText,
  Bell,
  Users,
  Building2,
  MapPin,
  Satellite
} from 'lucide-react';
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
import PeopleAccessAdminSection from './PeopleAccessAdmin/PeopleAccessAdminSection';
import RolesAdminSection from './RolesAdmin/RolesAdminSection';
import ActivityAdminSection from './ActivityAdmin/ActivityAdminSection';
import AuditAdminSection from './AuditAdmin/AuditAdminSection';
import NotificationsAdminSection from './NotificationsAdmin/NotificationsAdminSection';
import EmpresasAdminSection from './EmpresasAdmin/EmpresasAdminSection';
import DestinosAdminSection from './DestinosAdmin/DestinosAdminSection';
import './admin-ui.css';

/** Grupos de navegación admin (orden de producto). */
const ADMIN_NAV_GROUPS = [
  {
    id: 'personas',
    label: 'Personas y accesos',
    items: [
      { id: 'users', label: 'Usuarios', icon: KeyRound, match: (u) => hasPermission(u, 'users.view') },
      {
        id: 'roles',
        label: 'Roles',
        icon: ShieldCheck,
        match: (u) => hasPermission(u, 'roles.view') || hasPermission(u, 'roles.manage')
      },
      {
        id: 'permissions',
        label: 'Permisos',
        icon: Settings,
        match: (u) => hasPermission(u, 'settings.permissions')
      },
      {
        id: 'peopleAccess',
        label: 'Acceso personal',
        icon: Users,
        match: (u) =>
          hasPermission(u, 'access.doors.manage')
          || hasPermission(u, 'access.control')
          || hasPermission(u, 'master.nomina.write')
      }
    ]
  },
  {
    id: 'infra',
    label: 'Infraestructura',
    items: [
      {
        id: 'doors',
        label: 'Puertas y acceso',
        icon: DoorOpen,
        match: (u) => hasPermission(u, 'access.doors.manage') || hasPermission(u, 'access.control')
      },
      {
        id: 'notifications',
        label: 'Notificaciones',
        icon: Bell,
        match: (u) => hasPermission(u, 'notifications.config')
      },
      {
        id: 'access',
        label: 'GPS flota',
        icon: Satellite,
        match: (u) => hasPermission(u, 'access.control')
      }
    ]
  },
  {
    id: 'maestros',
    label: 'Datos maestros',
    items: [
      {
        id: 'nomina',
        label: 'Nómina',
        icon: ClipboardList,
        match: (u) => hasPermission(u, 'master.nomina.write')
      },
      {
        id: 'citaciones',
        label: 'Autorizaciones',
        icon: QrCode,
        match: (u) => hasPermission(u, 'master.citaciones.write')
      },
      {
        id: 'vehicles',
        label: 'Vehículos',
        icon: Car,
        match: (u) => hasPermission(u, 'master.vehicles.write')
      },
      {
        id: 'fleet',
        label: 'Flota interna',
        icon: Truck,
        match: (u) => hasPermission(u, 'fleet.upload')
      },
      {
        id: 'empresas',
        label: 'Empresas',
        icon: Building2,
        match: (u) => hasPermission(u, 'empresas.manage')
      },
      {
        id: 'destinos',
        label: 'Destinos',
        icon: MapPin,
        match: (u) => hasPermission(u, 'destinos.manage')
      }
    ]
  },
  {
    id: 'supervision',
    label: 'Supervisión',
    items: [
      {
        id: 'activity',
        label: 'Actividad',
        icon: Activity,
        match: (u) =>
          hasPermission(u, 'users.view')
          || hasPermission(u, 'roles.view')
          || hasPermission(u, 'settings.permissions')
      },
      {
        id: 'audit',
        label: 'Auditoría',
        icon: ScrollText,
        match: (u) => hasPermission(u, 'audit.view')
      }
    ]
  }
];

/**
 * Panel de administración completo.
 * @param {{ adminSection: string, onSectionChange: (id: string) => void, onExit?: () => void, onAccessConfigSaved?: (cfg: object) => void }} props
 */
function AdminPage({ adminSection, onSectionChange, onExit, onAccessConfigSaved, authPrefillKey = 0 }) {
  void onExit;
  const { authToken, currentUser } = useAuth();
  const { pendingAction, setPendingAction, runAction } = useAdminAction();
  const setAdminSection = onSectionChange;

  const [permissionKeys, setPermissionKeys] = useState([]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, authToken]);

  const adminNavGroups = useMemo(() => {
    if (!currentUser) return [];
    return ADMIN_NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.match(currentUser))
    })).filter((group) => group.items.length > 0);
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
            {adminNavGroups.map((group) => (
              <div key={group.id} className="admin-nav-group">
                <p className="admin-nav-group__label">{group.label}</p>
                {group.items.map(({ id, label, icon: Icon }) => (
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
              </div>
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

            {adminSection === 'peopleAccess'
              && (hasPermission(currentUser, 'access.doors.manage')
                || hasPermission(currentUser, 'access.control')
                || hasPermission(currentUser, 'master.nomina.write'))
              && (
                <PeopleAccessAdminSection />
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

            {adminSection === 'empresas' && hasPermission(currentUser, 'empresas.manage') && (
              <EmpresasAdminSection pendingAction={pendingAction} runAction={runAction} />
            )}

            {adminSection === 'destinos' && hasPermission(currentUser, 'destinos.manage') && (
              <DestinosAdminSection pendingAction={pendingAction} runAction={runAction} />
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

            {adminSection === 'audit' && hasPermission(currentUser, 'audit.view') && (
              <AuditAdminSection />
            )}

            {adminSection === 'notifications' && hasPermission(currentUser, 'notifications.config') && (
              <NotificationsAdminSection pendingAction={pendingAction} runAction={runAction} />
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
