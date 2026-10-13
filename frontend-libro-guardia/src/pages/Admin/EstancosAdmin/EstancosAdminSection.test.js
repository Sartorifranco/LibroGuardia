import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EstancosAdminSection from './EstancosAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: { role: 'admin', permissions: ['access.doors.manage'] } })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({ showSuccess: jest.fn(), showError: jest.fn() })
}));

const mockConfirm = jest.fn(async () => true);
jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: mockConfirm })
}));

const { apiFetch } = require('../../../services/api');

const doors = [
  { id: 'guardia', name: 'Puerta Guardia' },
  { id: 'teso', name: 'Ingreso Teso y Camioneros' },
  { id: 'depo', name: 'Ingreso Depositario' },
  { id: 'playa', name: 'Portón Playa', airlockGroupId: 'estanco-playa', airlockRole: 'outer' }
];

const playa = { id: 'estanco-playa', name: 'Estanco Playa', doorIds: ['playa', 'depo'], outerDoorId: 'playa', enabled: true, mode: 'sequential_closed' };

describe('pantalla Estancos', () => {
  const saved = [];

  beforeEach(() => {
    saved.length = 0;
    mockConfirm.mockImplementation(async () => true);
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/doors-config' && opts.method === 'PUT') {
        saved.push(opts.body);
        return { config: { doors: opts.body.doors, airlockGroups: opts.body.airlockGroups, defaultDoorId: opts.body.defaultDoorId } };
      }
      if (path === '/admin/doors-config') {
        return { config: { doors, airlockGroups: [playa], defaultDoorId: 'guardia' } };
      }
      return {};
    });
  });

  const findCard = async (name) => {
    await screen.findByRole('heading', { name });
    return screen.getAllByRole('article').find((item) => within(item).queryByRole('heading', { name }));
  };

  test('lista los estancos y marca la puerta de afuera', async () => {
    render(<EstancosAdminSection />);
    const card = await findCard('Estanco Playa');
    expect(screen.getByText(/Un estanco es un lugar chico entre puertas/)).toBeInTheDocument();
    const list = within(card).getByRole('list', { name: 'Puertas de Estanco Playa' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Portón Playa (la de afuera)');
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('Ingreso Depositario');
  });

  test('crear un estanco de 3 puertas arma doorIds y outerDoorId', async () => {
    render(<EstancosAdminSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Crear estanco' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo estanco' });
    await userEvent.type(within(dialog).getByLabelText('Nombre del estanco'), 'Estanco Guardia');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ingreso Teso y Camioneros' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Puerta Guardia' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ingreso Depositario' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('¿Cuál es la puerta de afuera?'), 'guardia');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const body = saved[0];
    expect(body.airlockGroups).toHaveLength(2);
    expect(body.airlockGroups[0]).toEqual(playa);
    expect(body.airlockGroups[1]).toEqual({
      id: 'estanco-guardia',
      name: 'Estanco Guardia',
      doorIds: ['guardia', 'teso', 'depo'],
      outerDoorId: 'guardia',
      enabled: true,
      mode: 'sequential_closed'
    });
    expect(body.defaultDoorId).toBe('guardia');
    const byId = Object.fromEntries(body.doors.map((door) => [door.id, door]));
    expect(byId.guardia).toMatchObject({ airlockGroupId: 'estanco-guardia', airlockRole: 'outer' });
    expect(byId.teso).toMatchObject({ airlockGroupId: 'estanco-guardia', airlockRole: 'inner' });
    expect(byId.depo).toMatchObject({ airlockGroupId: 'estanco-playa', airlockRole: 'inner' });
    expect(await screen.findByRole('heading', { name: 'Estanco Guardia' })).toBeInTheDocument();
  });

  test('con menos de 2 puertas avisa y no guarda', async () => {
    render(<EstancosAdminSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Crear estanco' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo estanco' });
    await userEvent.type(within(dialog).getByLabelText('Nombre del estanco'), 'Estanco Solo');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Puerta Guardia' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('¿Cuál es la puerta de afuera?'), 'guardia');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await within(dialog).findByText(/Marcá al menos 2 puertas/)).toBeInTheDocument();
    expect(saved).toHaveLength(0);
  });

  test('borrar un estanco pide confirmación', async () => {
    render(<EstancosAdminSection />);
    const card = await findCard('Estanco Playa');
    await userEvent.click(within(card).getByRole('button', { name: 'Borrar' }));
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Borrar estanco' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].airlockGroups).toEqual([]);
    expect(saved[0].doors.find((door) => door.id === 'playa')).toMatchObject({ airlockGroupId: null, airlockRole: null });
  });
});
