import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmProvider } from '../context/ConfirmContext';
import DoorsAdminPanel from './DoorsAdminPanel';

jest.mock('../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../services/api');

const areas = {
  areas: [
    { id: 'exterior', name: 'Exterior', fixed: true },
    { id: 'estacionamiento', name: 'Estacionamiento' },
    { id: 'planta', name: 'Planta' }
  ]
};

function renderDoors() {
  return render(
    <ConfirmProvider>
      <DoorsAdminPanel
        authToken="token-test"
        pendingAction={null}
        onPending={async (_id, fn) => { await fn(); }}
        onSuccess={jest.fn()}
        onError={jest.fn()}
      />
    </ConfirmProvider>
  );
}

describe('esquema afuera y adentro de una puerta', () => {
  const saved = [];

  beforeEach(() => {
    saved.length = 0;
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/areas') return areas;
      if (path === '/admin/doors/physical-status') return { doors: [] };
      if (path === '/admin/devices') return { devices: [] };
      if (path === '/admin/doors-config' && opts.method === 'PUT') {
        saved.push(opts.body);
        return {
          config: {
            doors: opts.body.doors,
            airlockGroups: opts.body.airlockGroups,
            defaultDoorId: opts.body.defaultDoorId
          },
          globalAccess: opts.body.globalAccess || {}
        };
      }
      if (path === '/admin/doors-config') {
        return { config: { doors: [], airlockGroups: [] }, globalAccess: {} };
      }
      return {};
    });
  });

  test('explica afuera y adentro, invierte y guarda los lectores del lado elegido', async () => {
    renderDoors();
    await userEvent.click(await screen.findByRole('button', { name: 'Crear puerta' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(/Lugar de afuera/)).toBeInTheDocument();
    expect(screen.getByText(/Lugar de adentro/)).toBeInTheDocument();
    expect(screen.getByLabelText('¿Desde dónde se llega a esta puerta?')).toBeInTheDocument();
    expect(screen.getByLabelText('¿A qué lugar se entra al pasarla?')).toBeInTheDocument();
    expect(screen.getByText(/Ej\.: del Estacionamiento a la Planta/)).toBeInTheDocument();
    expect(screen.getByText(/si la persona ENTRÓ o SALIÓ/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Afuera y adentro/ })).toHaveAttribute('aria-checked', 'true');

    expect(await screen.findAllByRole('option', { name: 'Estacionamiento' })).not.toHaveLength(0);
    const from = screen.getByLabelText('¿Desde dónde se llega a esta puerta?');
    const to = screen.getByLabelText('¿A qué lugar se entra al pasarla?');
    await userEvent.selectOptions(from, 'estacionamiento');
    await userEvent.selectOptions(to, 'planta');
    await userEvent.click(screen.getByRole('button', { name: /Invertir/ }));
    expect(from).toHaveValue('planta');
    expect(to).toHaveValue('estacionamiento');

    await userEvent.click(screen.getByRole('radio', { name: /Solo afuera/ }));
    expect(screen.getByRole('radio', { name: /Solo afuera/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByPlaceholderText('Portón de clientes'), 'Portón de clientes');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const door = saved[0].doors[0];
    expect(door.sides.in).toEqual({ zoneFrom: 'planta', zoneTo: 'estacionamiento' });
    expect(door.sides.out).toEqual({ zoneFrom: 'estacionamiento', zoneTo: 'planta' });
    expect(door.readers).toEqual([
      expect.objectContaining({ direction: 'ingreso', side: 'in' })
    ]);
    expect(door.readers.some((reader) => reader.side === 'out')).toBe(false);
    expect(await screen.findByText('La maneja: Sin equipo')).toBeInTheDocument();
    expect(screen.getByText('Planta')).toBeInTheDocument();
    expect(screen.getByText('Estacionamiento')).toBeInTheDocument();
  });
});
