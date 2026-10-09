import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmProvider } from '../../../context/ConfirmContext';
import EquiposAdminSection from './EquiposAdminSection';
import EquiposAccesoAdminSection from '../EquiposAccesoAdmin/EquiposAccesoAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: { role: 'admin', permissions: ['lectores.manage'] }
  })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({
    showSuccess: jest.fn(),
    showError: jest.fn()
  })
}));

const { apiFetch } = require('../../../services/api');

const catalog = {
  devices: [
    {
      id: 'ctl-viejo',
      name: 'Portón',
      kind: 'controller',
      status: 'active',
      doorIds: ['exterior'],
      health: {
        code: 'offline',
        label: 'Sin conexión',
        detail: 'Último contacto hace 2 h',
        configLabel: 'Actualizado'
      }
    },
    {
      id: 'ctl-malo',
      name: 'Molinete',
      kind: 'controller',
      status: 'active',
      doorIds: [],
      health: {
        code: 'problem',
        label: 'Con problemas',
        detail: 'Lector desconectado',
        configLabel: 'Actualizando…'
      }
    }
  ],
  doors: [
    { id: 'exterior', name: 'Exterior', controllerId: 'ctl-viejo', groupName: 'Estanco principal' },
    { id: 'interior', name: 'Interior', controllerId: null, groupName: 'Estanco principal' }
  ],
  airlocks: [{ id: 'e1', name: 'Estanco principal', doorIds: ['exterior', 'interior'] }]
};

function renderEquipos() {
  return render(
    <ConfirmProvider>
      <EquiposAdminSection />
    </ConfirmProvider>
  );
}

describe('asistente de equipos', () => {
  const posts = [];

  beforeEach(() => {
    posts.length = 0;
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/devices' && opts.method === 'POST') {
        posts.push(opts.body);
        return {
          device: { id: 'ctl-nuevo', name: opts.body.name, kind: opts.body.kind, status: 'pending', doorIds: opts.body.doorIds },
          enrollment: {
            code: 'ABCD2345',
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
          }
        };
      }
      if (String(path).includes('/log')) {
        if (String(path).includes('cursor=')) {
          return { events: [{ id: 'e2', message: 'Quedó instalado' }], nextCursor: null };
        }
        return { events: [{ id: 'e1', message: 'Alta del equipo' }], nextCursor: 'e1' };
      }
      return catalog;
    });
  });

  test('avisa el estanco y confirma el pase de puerta antes de crear', async () => {
    renderEquipos();
    expect(await screen.findByText('Con problemas')).toBeInTheDocument();
    expect(screen.getByText(/Lector desconectado/)).toBeInTheDocument();
    expect(screen.getByText('Actualizando…')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Agregar equipo' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Controlador de puertas' }));
    await userEvent.type(screen.getByLabelText('Nombre del equipo'), 'Nuevo');
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));

    await userEvent.click(screen.getByRole('checkbox', { name: /Exterior/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Crear código de instalación' }));
    expect(await screen.findByText(/tienen que quedar en el mismo equipo/)).toBeInTheDocument();
    expect(posts).toHaveLength(0);

    await userEvent.click(screen.getByRole('checkbox', { name: /Interior/ }));
    expect(screen.getByText('Esta puerta pasa del equipo Portón al nuevo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Crear código de instalación' }));

    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(posts).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Crear código de instalación' }));
    const again = await screen.findByRole('alertdialog');
    await userEvent.click(within(again).getByRole('button', { name: 'Pasar las puertas' }));

    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    expect(screen.getByText(/En el equipo ejecutá el instalador y escribí este código/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0].confirmMoves).toBe(true);
    expect(posts[0].doorIds).toEqual(['exterior', 'interior']);
    expect(posts[0].kind).toBe('controller');
  });

  test('la bitácora pide la página siguiente', async () => {
    renderEquipos();
    const buttons = await screen.findAllByRole('button', { name: 'Ver bitácora' });
    await userEvent.click(buttons[0]);
    expect(await screen.findByText('Alta del equipo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ver más' }));
    expect(await screen.findByText('Quedó instalado')).toBeInTheDocument();
    const logCalls = apiFetch.mock.calls.filter(([path]) => String(path).includes('/log'));
    expect(logCalls.some(([path]) => String(path).includes('cursor=e1'))).toBe(true);
  });

  test('Equipos es la entrada y el modo anterior sigue disponible', async () => {
    render(
      <ConfirmProvider>
        <EquiposAccesoAdminSection />
      </ConfirmProvider>
    );
    const equipos = await screen.findByRole('tab', { name: 'Equipos' });
    expect(equipos).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Equipos (modo anterior)' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Lectores' })).not.toBeInTheDocument();
  });
});
