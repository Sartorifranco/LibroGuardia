import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SiteMapSection from './SiteMapSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: { role: 'admin', permissions: ['access.doors.manage'] } })
}));

const { apiFetch } = require('../../../services/api');

const side = (from, to) => ({ in: { zoneFrom: from, zoneTo: to }, out: { zoneFrom: to, zoneTo: from } });
const both = [{ side: 'in' }, { side: 'out' }];

function mockPredio({ doors, airlockGroups = [], areas }) {
  apiFetch.mockImplementation(async (path) => {
    if (path === '/admin/areas') return { areas };
    if (path === '/admin/doors-config') return { config: { doors, airlockGroups }, globalAccess: {} };
    return {};
  });
}

const baseAreas = [
  { id: 'exterior', name: 'Exterior', fixed: true },
  { id: 'planta', name: 'Planta' },
  { id: 'esclusa', name: 'Esclusa' },
  { id: 'tesoreria', name: 'Tesorería' }
];

const baseDoors = [
  { id: 'porton', name: 'Portón', kind: 'gate', active: true, readers: both, sides: side('exterior', 'planta') },
  { id: 'e1', name: 'Estanco afuera', kind: 'door', active: true, readers: both, sides: side('planta', 'esclusa') },
  { id: 'e2', name: 'Estanco adentro', kind: 'door', active: true, readers: both, sides: side('esclusa', 'tesoreria') }
];

const groups = [{ id: 'g1', name: 'Estanco', doorIds: ['e1', 'e2'], outerDoorId: 'e1' }];

describe('SiteMapSection', () => {
  afterEach(() => jest.clearAllMocks());

  test('dibuja lugares y puertas y avisa que no hay problemas', async () => {
    mockPredio({ areas: baseAreas, doors: baseDoors, airlockGroups: groups });
    const onOpen = jest.fn();
    render(<SiteMapSection onOpen={onOpen} />);

    expect(await screen.findByText('No encontramos problemas.')).toBeInTheDocument();
    expect(screen.getByText('Mapa del predio')).toBeInTheDocument();
    expect(screen.getByText(/Muestra cómo se conectan los lugares y las puertas del predio/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Dibujo del predio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lugar Esclusa \(estanco\)/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Portón Portón\. Abrir Puertas/ }));
    expect(onOpen).toHaveBeenLastCalledWith('puertas');
    await userEvent.click(screen.getByRole('button', { name: /Lugar Planta\. Abrir Lugares/ }));
    expect(onOpen).toHaveBeenLastCalledWith('lugares');

    expect(apiFetch).toHaveBeenCalledWith('/admin/doors-config', expect.objectContaining({ token: 'token-test' }));
    expect(apiFetch).toHaveBeenCalledWith('/admin/areas', expect.objectContaining({ token: 'token-test' }));
  });

  test('lista los problemas con botón Arreglar', async () => {
    mockPredio({
      areas: [...baseAreas, { id: 'deposito', name: 'Depósito' }, { id: 'planta2', name: 'Planta' }],
      doors: [
        ...baseDoors,
        { id: 'p2', name: 'Otra', kind: 'door', active: true, readers: [], sides: side('planta', 'planta2') }
      ],
      airlockGroups: groups
    });
    const onOpen = jest.fn();
    render(<SiteMapSection onOpen={onOpen} />);

    const review = await screen.findByRole('region', { name: 'Revisión automática' });
    expect(within(review).getByText('El lugar “Depósito” no tiene ninguna puerta.')).toBeInTheDocument();
    expect(within(review).getByText(/Hay 2 lugares que se llaman “Planta”/)).toBeInTheDocument();

    await userEvent.click(within(review).getByRole('button', { name: /Arreglar en Lugares/ }));
    expect(onOpen).toHaveBeenLastCalledWith('lugares');
    await userEvent.click(within(review).getByRole('button', { name: /Arreglar en Puertas/ }));
    expect(onOpen).toHaveBeenLastCalledWith('puertas');
  });

  test('en celular muestra el árbol en vez del dibujo', async () => {
    const original = window.matchMedia;
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
    try {
      mockPredio({ areas: baseAreas, doors: baseDoors, airlockGroups: groups });
      render(<SiteMapSection onOpen={jest.fn()} />);
      expect(await screen.findByRole('button', { name: 'Portón: Portón' })).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Dibujo del predio' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Puerta: Estanco adentro' })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});
