import React, { useEffect, useMemo, useState } from 'react';
import { Settings, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { hasPermission } from '../../utils/permissions';
import { buildAdminNav, canOpenAdvancedSection } from '../../utils/adminNav';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../services/api';
import { ADMIN_SECTION_META } from './adminConstants';
import { useAdminAction } from './hooks/useAdminAction';
import { PageHeader, PageContainer } from '../../components/admin-ui';
import UsersAdminSection from './UsersAdmin/UsersAdminSection';
import CitacionesAdminSection from './CitacionesAdmin/CitacionesAdminSection';
import AccessGpsAdminSection from './AccessGpsAdmin/AccessGpsAdminSection';
import NominaAdminSection from './NominaAdmin/NominaAdminSection';
import VehiclesAdminSection from './VehiclesAdmin/VehiclesAdminSection';
import FleetAdminSection from './FleetAdmin/FleetAdminSection';
import PeopleAccessAdminSection from './PeopleAccessAdmin/PeopleAccessAdminSection';
import AccessModelAdminSection from './AccessModelAdmin/AccessModelAdminSection';
import EmpresasAdminSection from './EmpresasAdmin/EmpresasAdminSection';
import DestinosAdminSection from './DestinosAdmin/DestinosAdminSection';
import EquiposAccesoAdminSection from './EquiposAccesoAdmin/EquiposAccesoAdminSection';
import EquiposAdminSection from './EquiposAdmin/EquiposAdminSection';
import AutorizacionesHub from './AutorizacionesAdmin/AutorizacionesHub';
import AppearanceAdminSection from './AppearanceAdmin/AppearanceAdminSection';
import NotificationsAdminSection from './NotificationsAdmin/NotificationsAdminSection';
import PrimerosPasosSection from './PrimerosPasos/PrimerosPasosSection';
import LugaresAdminSection from './LugaresAdmin/LugaresAdminSection';
import RolesPermisosSection from './RolesPermisos/RolesPermisosSection';
import RegistroAdminSection from './RegistroAdmin/RegistroAdminSection';
import ConsumoAdminSection from './ConsumoAdmin/ConsumoAdminSection';
import HuellaAdminSection from './HuellaAdmin/HuellaAdminSection';
import CitacionesAutoSection from './CitacionesAuto/CitacionesAutoSection';
import DoorsAdminSection from './DoorsAdmin/DoorsAdminSection';
import './admin-ui.css';

const ADVANCED_KEY = 'mss-admin-show-advanced';

const OWN_HEADER = new Set([
  'primerosPasos',
  'lugares',
  'puertas',
  'equipos',
  'rolesPermisos',
  'registro',
  'consumo',
  'huella',
  'citacionesAuto',
  'grupos',
  'horarios',
  'feriados',
  'puedePasar',
  'appearance',
  'sistemas',
  'visitas'
]);

const ACCESS_TAB = {
  grupos: 'grupos',
  horarios: 'horarios',
  feriados: 'feriados',
  puedePasar: 'simular',
  negocioAccesos: 'grupos'
};

const ACCESS_COPY = {
  grupos: {
    title: 'Grupos de acceso',
    purpose: 'Un grupo junta puertas y un horario. Las personas del grupo pasan por esas puertas.',
    howTo: ['Creá el grupo y ponéle un nombre.', 'Elegí las puertas y el horario.', 'Después asignalo a las personas.']
  },
  horarios: {
    title: 'Horarios',
    purpose: 'Un horario dice en qué días y horas vale un permiso.',
    howTo: ['Creá el horario.', 'Marcá los días y el desde-hasta.', 'Usalo en un grupo de acceso.']
  },
  feriados: {
    title: 'Feriados',
    purpose: 'En un feriado el horario puede no valer, según cómo lo configuraste.',
    howTo: ['Elegí el año.', 'Cargá los feriados.', 'Revisá que el horario sepa qué hacer ese día.']
  },
  puedePasar: {
    title: '¿Puede pasar?',
    purpose: 'Probá si una persona puede entrar por una puerta, en un día y una hora.',
    howTo: ['Elegí la persona.', 'Elegí la puerta y el momento.', 'Mirá si puede pasar y por qué.']
  }
};

function AdminPage({ adminSection, adminQuery = {}, onSectionChange, onExit, onAccessConfigSaved, authPrefillKey = 0 }) {
  void onExit;
  const navigate = useNavigate();
  const { authToken, currentUser } = useAuth();
  const { pendingAction, setPendingAction, runAction } = useAdminAction();
  const setAdminSection = onSectionChange;
  const [permissionKeys, setPermissionKeys] = useState([]);
  const [setupPercent, setSetupPercent] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(() => {
    try { return localStorage.getItem(ADVANCED_KEY) === '1'; } catch { return false; }
  });

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

  useEffect(() => {
    let cancel = false;
    apiFetch('/admin/setup-status', { token: authToken, allowForbidden: true })
      .then((data) => { if (!cancel) setSetupPercent(data?.progress?.percent ?? null); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [authToken, adminSection]);

  const advancedOn = canOpenAdvancedSection(currentUser, showAdvanced);
  const adminNavGroups = useMemo(
    () => buildAdminNav(currentUser, { showAdvanced: advancedOn }),
    [currentUser, advancedOn]
  );

  const toggleAdvanced = () => {
    const next = !showAdvanced;
    setShowAdvanced(next);
    try { localStorage.setItem(ADVANCED_KEY, next ? '1' : '0'); } catch { /* el interruptor igual cambia en esta visita */ }
    if (!next && adminSection === 'sistemas') setAdminSection('primerosPasos');
  };

  const activeAdminMeta = ADMIN_SECTION_META[adminSection] || { title: 'Administración', description: '' };
  const showOwnHeader = OWN_HEADER.has(adminSection);
  const accessCopy = ACCESS_COPY[adminSection];
  const canDoors = hasPermission(currentUser, 'access.doors.manage') || hasPermission(currentUser, 'access.control');

  return (
    <div className="admin-panel">
      <div className="admin-panel-top">
        <div>
          <span className="admin-panel-badge"><Settings size={12} /> Administración</span>
          <h2>Panel de control</h2>
          <p>Configuración del sistema.</p>
        </div>
        {pendingAction && (
          <div className="admin-action-indicator">
            <Loader2 className="animate-spin" size={18} />
            <span>
              {String(pendingAction).startsWith('upload-nomina:')
                ? `Importando nómina… ${String(pendingAction).slice('upload-nomina:'.length)}`
                : 'Acción en curso…'}
            </span>
          </div>
        )}
      </div>

      <div className="admin-panel-layout">
        <aside className="admin-sidebar" aria-label="Secciones de administración">
          {adminNavGroups.map((group) => (
            <div key={group.id} className="admin-nav-group">
              <p className="admin-nav-group__label">{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = adminSection === item.id || (item.fallbackSection && adminSection === item.fallbackSection && !item.href);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`admin-sidebar-btn${active ? ' active' : ''}`}
                    onClick={() => {
                      if (item.href) navigate(item.href);
                      else setAdminSection(item.fallbackSection || item.id);
                    }}
                  >
                    <Icon size={18} aria-hidden />
                    <span className="admin-sidebar-btn__text">
                      <span>{item.label}</span>
                      <span className="admin-sidebar-btn__desc">{item.description}</span>
                      {item.id === 'primerosPasos' && setupPercent != null ? (
                        <span className="admin-setup-bar" aria-hidden>
                          <span style={{ width: `${setupPercent}%` }} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {currentUser?.role === 'admin' ? (
            <label className="aui-check admin-advanced-toggle">
              <input type="checkbox" checked={showAdvanced} onChange={toggleAdvanced} />
              <span>
                Mostrar opciones avanzadas
                <small className="admin-sidebar-btn__desc">Para el instalador. El resto del personal no las ve.</small>
              </span>
            </label>
          ) : null}
        </aside>

        <div className="admin-content">
          {!showOwnHeader && (
            <div className="admin-content-header">
              <h3>{activeAdminMeta.title}</h3>
              <p>{activeAdminMeta.description}</p>
            </div>
          )}

          {adminSection === 'primerosPasos' && (
            <PrimerosPasosSection onOpen={setAdminSection} />
          )}

          {adminSection === 'users' && hasPermission(currentUser, 'users.view') && (
            <UsersAdminSection pendingAction={pendingAction} runAction={runAction} permissionKeys={permissionKeys} />
          )}

          {adminSection === 'rolesPermisos' && (
            <RolesPermisosSection
              initialTab={adminQuery.tab === 'permisos' ? 'permisos' : 'roles'}
              pendingAction={pendingAction}
              runAction={runAction}
              onPermissionKeysChange={setPermissionKeys}
            />
          )}

          {adminSection === 'citaciones' && hasPermission(currentUser, 'master.citaciones.write') && (
            <CitacionesAdminSection
              pendingAction={pendingAction}
              runAction={runAction}
              setPendingAction={setPendingAction}
              authPrefillKey={authPrefillKey}
            />
          )}

          {adminSection === 'lugares' && canDoors && <LugaresAdminSection />}

          {adminSection === 'puertas' && canDoors && (
            <DoorsAdminSection
              pendingAction={pendingAction}
              runAction={runAction}
              onAccessConfigSaved={onAccessConfigSaved}
            />
          )}

          {adminSection === 'equipos' && hasPermission(currentUser, 'lectores.manage') && (
            <EquiposAdminSection />
          )}

          {adminSection === 'sistemas' && advancedOn && (
            <>
              <PageHeader
                title="Sistemas"
                purpose="Para el instalador. La forma anterior de cargar equipos, las marcas y los paquetes."
                howTo={[
                  'Usá Equipos y Puertas del menú para el día a día.',
                  'Abrí esto solo si hay que ver la forma anterior.',
                  'Las marcas y los paquetes están en las otras pestañas.'
                ]}
              />
              <EquiposAccesoAdminSection
                pendingAction={pendingAction}
                runAction={runAction}
                onAccessConfigSaved={onAccessConfigSaved}
                advancedOnly
                initialTab="anterior"
              />
            </>
          )}

          {adminSection === 'sistemas' && !advancedOn && (
            <PageHeader
              title="Sistemas"
              purpose="Esta parte es para el instalador. No hace falta para configurar el predio."
              howTo={['Volvé a Puertas o a Equipos.', 'Si sos el instalador, activá Mostrar opciones avanzadas.']}
            />
          )}

          {adminSection === 'peopleAccess' && (
            hasPermission(currentUser, 'access.doors.manage')
            || hasPermission(currentUser, 'access.control')
            || hasPermission(currentUser, 'master.nomina.write')
          ) && (
            <PeopleAccessAdminSection />
          )}

          {ACCESS_TAB[adminSection] && (
            hasPermission(currentUser, 'access.groups.manage')
            || hasPermission(currentUser, 'personas.puertas.asignar')
          ) && accessCopy && (
            <PageContainer width="medium">
              <PageHeader title={accessCopy.title} purpose={accessCopy.purpose} howTo={accessCopy.howTo} />
              <AccessModelAdminSection initialTab={ACCESS_TAB[adminSection]} lockTab />
            </PageContainer>
          )}

          {adminSection === 'access' && hasPermission(currentUser, 'access.control') && (
            <AccessGpsAdminSection pendingAction={pendingAction} runAction={runAction} />
          )}

          {adminSection === 'nomina' && hasPermission(currentUser, 'master.nomina.write') && (
            <NominaAdminSection pendingAction={pendingAction} setPendingAction={setPendingAction} runAction={runAction} />
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

          {adminSection === 'visitas' && hasPermission(currentUser, 'visitas.approve') && (
            <AutorizacionesHub />
          )}

          {adminSection === 'appearance' && hasPermission(currentUser, 'settings.permissions') && (
            <PageContainer width="narrow">
              <PageHeader
                title="Datos de la empresa"
                purpose="El nombre, el logo y los colores que se ven en el sistema."
                howTo={['Escribí el nombre de la empresa.', 'Subí el logo si tenés uno.', 'Elegí los colores y guardá.']}
              />
              <AppearanceAdminSection />
            </PageContainer>
          )}

          {adminSection === 'registro' && (
            <RegistroAdminSection initialTipo={adminQuery.tipo || 'todos'} />
          )}

          {adminSection === 'consumo' && <ConsumoAdminSection />}

          {adminSection === 'notifications' && hasPermission(currentUser, 'notifications.config') && (
            <NotificationsAdminSection pendingAction={pendingAction} runAction={runAction} />
          )}

          {adminSection === 'huella' && (
            <HuellaAdminSection />
          )}

          {adminSection === 'citacionesAuto' && hasPermission(currentUser, 'master.citaciones.write') && (
            <CitacionesAutoSection />
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminPage;
