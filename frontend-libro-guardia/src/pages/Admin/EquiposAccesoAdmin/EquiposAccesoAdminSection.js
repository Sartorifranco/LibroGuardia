import React, { useMemo, useState } from 'react';
import { DoorOpen, ScanLine, Server, BookOpen, BadgeCheck, Package } from 'lucide-react';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import DoorsAdminSection from '../DoorsAdmin/DoorsAdminSection';
import LectoresAdminSection from '../LectoresAdmin/LectoresAdminSection';
import EstacionesAdminSection from '../EstacionesAdmin/EstacionesAdminSection';
import { ACCESS_HARDWARE_BRANDS, ACCESS_COMMERCIAL_PROFILES } from '../accessHardwareBrands';

const TABS = [
  { id: 'guia', label: 'Cómo empezar', icon: BookOpen },
  { id: 'puertas', label: 'Puertas', icon: DoorOpen },
  { id: 'lectores', label: 'Lectores', icon: ScanLine },
  { id: 'estaciones', label: 'Estaciones', icon: Server },
  { id: 'marcas', label: 'Marcas homologadas', icon: BadgeCheck },
  { id: 'paquetes', label: 'Paquetes de venta', icon: Package }
];

/**
 * Centro único de configuración de hardware de acceso.
 * Reúne puertas, lectores y estaciones para no duplicar lugares en el menú.
 */
function EquiposAccesoAdminSection({
  pendingAction,
  runAction,
  onAccessConfigSaved,
  initialTab = 'guia'
}) {
  const { currentUser } = useAuth();
  const [tab, setTab] = useState(initialTab);

  const canDoors = hasPermission(currentUser, 'access.doors.manage')
    || hasPermission(currentUser, 'access.control');
  const canLectores = hasPermission(currentUser, 'lectores.manage');

  const visibleTabs = useMemo(
    () => TABS.filter((item) => {
      if (item.id === 'puertas' || item.id === 'guia' || item.id === 'marcas' || item.id === 'paquetes') {
        return canDoors || canLectores;
      }
      if (item.id === 'lectores' || item.id === 'estaciones') return canLectores;
      return true;
    }),
    [canDoors, canLectores]
  );

  const activeTab = visibleTabs.some((t) => t.id === tab)
    ? tab
    : (visibleTabs[0]?.id || 'guia');

  const brandNameById = useMemo(() => {
    const map = new Map(ACCESS_HARDWARE_BRANDS.map((b) => [b.id, b.name]));
    return (id) => map.get(id) || id;
  }, []);

  if (!canDoors && !canLectores) {
    return <p className="text-sm text-gray-500">No tenés permiso para configurar equipos de acceso.</p>;
  }

  return (
    <div className="equipos-acceso-admin">
      <div className="equipos-acceso-tabs" role="tablist" aria-label="Equipos de acceso">
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={`equipos-acceso-tab${activeTab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={16} aria-hidden />
            {label}
          </button>
        ))}
      </div>

      <div className="equipos-acceso-panel" role="tabpanel">
        {activeTab === 'guia' && (
          <div className="equipos-acceso-guia">
            <h4>Configurá el acceso de la planta en 4 pasos</h4>
            <ol className="equipos-acceso-steps">
              <li>
                <strong>Puertas</strong>
                {' — '}
                Creá cada puerta, indicá si abre en planta o a distancia, con placa SR201 o por URL,
                y qué métodos acepta (DNI, tarjeta, biométrico).
              </li>
              <li>
                <strong>Lectores</strong>
                {' — '}
                Asociá el lector físico (DNI, tarjeta o biométrico) a esa puerta.
              </li>
              <li>
                <strong>Estaciones</strong>
                {' — '}
                Si usás mini PC en planta, agrupá lectores (plugin por marca) y dejá la apertura por red local.
              </li>
              <li>
                <strong>Personas</strong>
                {' — '}
                En
                {' '}
                <em>Acceso personal</em>
                {' '}
                cargá DNI, número de tarjeta y/o ID del biométrico de cada persona.
              </li>
            </ol>
            <p className="equipos-acceso-hint">
              Todo el control de acceso se configura acá. No hace falta entrar a menús separados
              de puertas o lectores. Para cotizar, mirá la pestaña Paquetes de venta.
            </p>
            <div className="equipos-acceso-guia-actions">
              {canDoors && (
                <button type="button" className="btn btn-primary" onClick={() => setTab('puertas')}>
                  Ir a Puertas
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setTab('paquetes')}>
                Ver paquetes de venta
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setTab('marcas')}>
                Ver marcas homologadas
              </button>
            </div>
          </div>
        )}

        {activeTab === 'puertas' && canDoors && (
          <DoorsAdminSection
            pendingAction={pendingAction}
            runAction={runAction}
            onAccessConfigSaved={onAccessConfigSaved}
          />
        )}

        {activeTab === 'lectores' && canLectores && (
          <LectoresAdminSection />
        )}

        {activeTab === 'estaciones' && canLectores && (
          <EstacionesAdminSection />
        )}

        {activeTab === 'marcas' && (
          <div className="equipos-acceso-marcas">
            <p className="equipos-acceso-hint">
              Estas son las marcas que MSS Guard está preparado para integrar primero.
              Otras marcas se pueden sumar más adelante sin cambiar el núcleo del sistema.
            </p>
            <div className="equipos-acceso-marcas-grid">
              {ACCESS_HARDWARE_BRANDS.map((brand) => (
                <article key={brand.id} className="equipos-acceso-marca-card">
                  <header>
                    <h4>{brand.name}</h4>
                    <div className="equipos-acceso-marca-tags">
                      {brand.kinds.map((k) => (
                        <span key={k}>{k}</span>
                      ))}
                    </div>
                  </header>
                  <p>{brand.summary}</p>
                  <p className="equipos-acceso-marca-connect">
                    <strong>Cómo se conecta:</strong>
                    {' '}
                    {brand.howItConnects}
                  </p>
                  <ol>
                    {brand.setupSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <p className="historial-meta">{brand.personFieldHint}</p>
                </article>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'paquetes' && (
          <div className="equipos-acceso-paquetes">
            <p className="equipos-acceso-hint">
              Perfiles para cotizar e instalar. Homologado = listo con la base actual.
              A medida = se evalúa un conector sobre el mismo contrato de acceso.
            </p>
            <div className="equipos-acceso-marcas-grid">
              {ACCESS_COMMERCIAL_PROFILES.map((profile) => (
                <article key={profile.id} className="equipos-acceso-marca-card">
                  <header>
                    <h4>{profile.name}</h4>
                    <div className="equipos-acceso-marca-tags">
                      <span className={profile.integration === 'custom' ? 'is-custom' : ''}>
                        {profile.integration === 'custom' ? 'A medida' : 'Homologado'}
                      </span>
                    </div>
                  </header>
                  <p>{profile.tagline}</p>
                  <p className="equipos-acceso-marca-connect">
                    <strong>Incluye:</strong>
                  </p>
                  <ul className="equipos-acceso-profile-list">
                    {profile.includes.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  {profile.brandIds?.length > 0 && (
                    <p className="historial-meta">
                      Marcas:
                      {' '}
                      {profile.brandIds.map(brandNameById).join(', ')}
                    </p>
                  )}
                  <p className="historial-meta">{profile.notes}</p>
                </article>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default EquiposAccesoAdminSection;
