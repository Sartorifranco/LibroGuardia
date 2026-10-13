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

  test('nombres largos sin … y con el nombre completo en el título', async () => {
    const largo = 'Ingreso Tesorería y Camioneros por Planta';
    mockPredio({
      areas: [...baseAreas.slice(0, 3), { id: 'tesoreria', name: 'Tesorería central de recuento' }],
      doors: [baseDoors[0], baseDoors[1], { ...baseDoors[2], name: largo }],
      airlockGroups: groups
    });
    const { container } = render(<SiteMapSection onOpen={jest.fn()} />);
    await screen.findByText('No encontramos problemas.');
    const svg = screen.getByRole('img', { name: 'Dibujo del predio' });
    expect(svg.textContent).not.toMatch(/…/);
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toContain('Tesorería central de recuento');
    expect(titles).toContain(`Puerta: ${largo}`);
    const door = screen.getByRole('button', { name: new RegExp(`Puerta ${largo}`) });
    expect(door.querySelectorAll('tspan')).toHaveLength(2);
  });

  test('lector de un solo lado: Está bien así guarda la puerta y recarga', async () => {
    const doors = [{ ...baseDoors[0], readers: [{ side: 'in' }] }, baseDoors[1], baseDoors[2]];
    let saved = null;
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/areas') return { areas: baseAreas };
      if (path === '/admin/doors-config' && opts.method === 'PUT') {
        saved = opts.body;
        return { config: { doors: opts.body.doors, airlockGroups: groups } };
      }
      if (path === '/admin/doors-config') {
        return { config: { doors: saved?.doors || doors, airlockGroups: groups, defaultDoorId: 'porton' } };
      }
      return {};
    });
    render(<SiteMapSection onOpen={jest.fn()} />);

    const review = await screen.findByRole('region', { name: 'Revisión automática' });
    expect(within(review).getByText(/Por ejemplo, si se entra por esta puerta pero se sale por otra/)).toBeInTheDocument();
    await userEvent.click(within(review).getByRole('button', { name: /Está bien así/ }));

    expect(await screen.findByText('No encontramos problemas.')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/admin/doors-config', expect.objectContaining({ method: 'PUT', token: 'token-test' }));
    expect(saved.defaultDoorId).toBe('porton');
    expect(saved.doors).toHaveLength(3);
    expect(saved.doors.find((d) => d.id === 'porton').singleSideReaderOk).toBe(true);
    expect(saved.doors.filter((d) => d.singleSideReaderOk)).toHaveLength(1);
  });

  test('puerta con singleSideReaderOk no muestra el aviso', async () => {
    mockPredio({
      areas: baseAreas,
      doors: [{ ...baseDoors[0], readers: [{ side: 'in' }], singleSideReaderOk: true }, baseDoors[1], baseDoors[2]],
      airlockGroups: groups
    });
    render(<SiteMapSection onOpen={jest.fn()} />);
    expect(await screen.findByText('No encontramos problemas.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Está bien así/ })).not.toBeInTheDocument();
  });

  test('Arreglar de un estanco lleva a Estancos', async () => {
    mockPredio({
      areas: baseAreas,
      doors: baseDoors,
      airlockGroups: [{ id: 'g1', name: 'Solito', doorIds: ['e1'], outerDoorId: 'e1' }]
    });
    const onOpen = jest.fn();
    render(<SiteMapSection onOpen={onOpen} />);
    const review = await screen.findByRole('region', { name: 'Revisión automática' });
    await userEvent.click(within(review).getByRole('button', { name: /Arreglar en Estancos: El estanco “Solito”/ }));
    expect(onOpen).toHaveBeenLastCalledWith('estancos');
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
