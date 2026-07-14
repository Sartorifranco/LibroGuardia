import React from 'react';
import { Settings } from 'lucide-react';

function AppSidebar({
  activeTab,
  onNavigate,
  onEnterAdmin,
  showAdmin,
  items = [],
}) {
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
