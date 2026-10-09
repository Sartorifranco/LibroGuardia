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

    await userEvent.click(screen.getByRole('button', { name: 'Instalar un equipo' }));
    await userEvent.click(screen.getByRole('button', { name: /Controlador de puertas/ }));
    await userEvent.type(screen.getByLabelText('Nombre del equipo'), 'Nuevo');
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    await userEvent.click(screen.getByRole('checkbox', { name: /Exterior/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/tienen que quedar en el mismo equipo/);
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
    expect(posts).toHaveLength(0);

    await userEvent.click(screen.getByRole('checkbox', { name: /Interior/ }));
    expect(screen.getByText('Esta puerta pasa del equipo Portón al nuevo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar el cambio de equipo' }));

    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(posts).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar el cambio de equipo' }));
    const again = await screen.findByRole('alertdialog');
    await userEvent.click(within(again).getByRole('button', { name: 'Pasar las puertas' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    expect(screen.getByText(/En la Raspberry\/PC abrí el instalador y escribí este código/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0].confirmMoves).toBe(true);
    expect(posts[0].doorIds).toEqual(['exterior', 'interior']);
    expect(posts[0].kind).toBe('controller');
  });

  test('la bitácora pide la página siguiente', async () => {
    renderEquipos();
    await userEvent.click(await screen.findByRole('button', { name: 'Ver Portón' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver bitácora' }));
    expect(await screen.findByText('Alta del equipo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ver más' }));
    expect(await screen.findByText('Quedó instalado')).toBeInTheDocument();
    const logCalls = apiFetch.mock.calls.filter(([path]) => String(path).includes('/log'));
    expect(logCalls.some(([path]) => String(path).includes('cursor=e1'))).toBe(true);
  });

  test('la prueba de instalación se tilda sola y abre la puerta', async () => {
    const timers = [];
    const realSetInterval = window.setInterval.bind(window);
    const realClearInterval = window.clearInterval.bind(window);
    jest.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
      if (ms === 5000) {
        timers.push(fn);
        return 5000;
      }
      return realSetInterval(fn, ms);
    });
    jest.spyOn(window, 'clearInterval').mockImplementation((id) => {
      if (id === 5000) return undefined;
      return realClearInterval(id);
    });

    let phase = 'off';
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/devices' && opts.method === 'POST') {
        posts.push(opts.body);
        return {
          device: { id: 'ctl-nuevo', name: opts.body.name, kind: 'controller', status: 'pending', doorIds: opts.body.doorIds },
          enrollment: { code: 'ABCD2345', expiresAt: new Date(Date.now() + 600000).toISOString() }
        };
      }
      if (String(path).includes('last-scans')) {
        return phase === 'on'
          ? { scans: [{ id: 's1', summary: 'Ana · entrada · permitido' }] }
          : { scans: [] };
      }
      if (String(path).includes('remote-open')) {
        return { command: { id: 'c1', status: 'done' } };
      }
      if (path === '/admin/devices') {
        return {
          devices: phase === 'on' ? [{
            id: 'ctl-nuevo',
            name: 'Caja',
            kind: 'controller',
            status: 'active',
            online: true,
            doorIds: ['p1'],
            checks: { serialConnected: true, relayReachable: true },
            health: { code: 'online', label: 'En línea', detail: null }
          }] : [],
          doors: [{ id: 'p1', name: 'Portón clientes', controllerId: null }],
          airlocks: []
        };
      }
      return { devices: [], doors: [], airlocks: [] };
    });

    renderEquipos();
    expect(await screen.findByText(/Todavía no instalaste ningún equipo/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Instalar un equipo' }));
    await userEvent.click(screen.getByRole('button', { name: /Controlador de puertas/ }));
    await userEvent.type(screen.getByLabelText('Nombre del equipo'), 'Caja');
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Portón clientes/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(await screen.findByText(/○ Equipo conectado/)).toBeInTheDocument();
    expect(screen.getByText(/pasá un DNI ahora/)).toBeInTheDocument();
    phase = 'on';
    expect(timers.length).toBeGreaterThan(0);
    await timers[timers.length - 1]();
    expect(await screen.findByText(/✓ Equipo conectado/)).toBeInTheDocument();
    expect(screen.getByText(/✓ Lector detectado/)).toBeInTheDocument();
    expect(screen.getByText(/✓ Placa de relé responde/)).toBeInTheDocument();
    expect(screen.getByText(/Ana · entrada · permitido/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Probar apertura' }));
    expect(await screen.findByText(/La puerta se abrió ✓/)).toBeInTheDocument();
    const openCall = apiFetch.mock.calls.find(([path, opts]) => String(path).includes('remote-open') && opts?.method === 'POST');
    expect(openCall[1].body.reason).toBe('prueba de instalación');

    window.setInterval.mockRestore();
    window.clearInterval.mockRestore();
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
