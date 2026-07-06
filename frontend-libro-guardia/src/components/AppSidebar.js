import React from 'react';
import {
  LayoutDashboard,
  User,
  Car,
  Truck,
  ClipboardList,
  Scan,
  FileText,
  List,
  Settings,
  ShieldCheck,
} from 'lucide-react';

function AppSidebar({
  activeTab,
  onNavigate,
  onEnterAdmin,
  showKiosk,
  showAutorizados,
  showAdmin,
}) {
  const items = [
    { id: 'inicio', label: 'Inicio', icon: LayoutDashboard },
    { id: 'personal', label: 'Personal', icon: User },
    { id: 'vehiculo', label: 'Vehículos externos', icon: Car },
    { id: 'flota', label: 'Flota interna', icon: Truck },
    { id: 'novedad', label: 'Novedades', icon: ClipboardList },
  ];

  if (showAutorizados) {
    items.splice(2, 0, { id: 'autorizados', label: 'Autorizados', icon: ShieldCheck });
  }

  if (showKiosk) {
    items.push({ id: 'kiosk', label: 'Molinete / Acceso', icon: Scan });
  }

  items.push(
    { id: 'reportes', label: 'Reportes', icon: FileText },
    { id: 'allRecords', label: 'Todos los registros', icon: List },
  );

  return (
    <nav className="app-sidebar" aria-label="Navegación principal">
      <p className="app-sidebar-label">Operación</p>
      <ul className="app-sidebar-list">
        {items.map(({ id, label, icon: Icon }) => (
          <li key={id}>
            <button
              type="button"
              className={`app-sidebar-link${activeTab === id ? ' active' : ''}`}
              onClick={() => onNavigate(id)}
            >
              <Icon size={18} aria-hidden />
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>
      {showAdmin && (
        <>
          <p className="app-sidebar-label app-sidebar-label-muted">Administración</p>
          <button
            type="button"
            className="app-sidebar-link app-sidebar-link-admin"
            onClick={onEnterAdmin}
          >
            <Settings size={18} aria-hidden />
            <span>Panel admin</span>
          </button>
        </>
      )}
    </nav>
  );
}

export default AppSidebar;
