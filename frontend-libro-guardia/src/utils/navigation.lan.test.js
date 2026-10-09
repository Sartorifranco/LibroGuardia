import React from 'react';
import { render, screen } from '@testing-library/react';
import { buildSidebarItems } from './navigation';

const supervisor = {
  role: 'supervisor',
  dashboardProfile: 'supervisor',
  permissions: [
    'entries.create',
    'entries.view',
    'reports.export',
    'fleet.gps.read',
    'attendance.alerts.read',
    'master.citaciones.read',
    'access.manual_open',
    'guard.doors.panel'
  ]
};

function Menu({ runtime }) {
  const items = buildSidebarItems(supervisor, runtime);
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  );
}

describe('menú según capabilities de la red local', () => {
  test('oculta reportes, flota y citaciones si el hub no las ofrece', () => {
    render(
      <Menu
        runtime={{
          mode: 'lan',
          capabilities: ['auth', 'doors', 'open', 'entries', 'alarms', 'live']
        }}
      />
    );

    expect(screen.getByText('Puertas')).toBeInTheDocument();
    expect(screen.getByText('Historial')).toBeInTheDocument();
    expect(screen.getByText('Alarmas')).toBeInTheDocument();
    expect(screen.queryByText('Flota')).not.toBeInTheDocument();
    expect(screen.queryByText('Reportes')).not.toBeInTheDocument();
    expect(screen.queryByText('Citados')).not.toBeInTheDocument();
    expect(screen.queryByText('Novedades')).not.toBeInTheDocument();
  });

  test('sin capability doors no muestra Puertas', () => {
    render(
      <Menu runtime={{ mode: 'lan', capabilities: ['entries'] }} />
    );
    expect(screen.queryByText('Puertas')).not.toBeInTheDocument();
    expect(screen.getByText('Historial')).toBeInTheDocument();
  });
});
