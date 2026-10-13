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

  test('muestra el recorrido de lugares y puertas y avisa que no hay problemas', async () => {
    mockPredio({ areas: baseAreas, doors: baseDoors, airlockGroups: groups });
    const onOpen = jest.fn();
    render(<SiteMapSection onOpen={onOpen} />);

    expect(await screen.findByText('No encontramos problemas.')).toBeInTheDocument();
    expect(screen.getByText('Mapa del predio')).toBeInTheDocument();
    expect(screen.getByText(/Muestra cómo se conectan los lugares y las puertas del predio/)).toBeInTheDocument();
    expect(screen.getByText(/Cada tarjeta es un lugar y adentro están sus puertas/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Recorrido del predio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Lugar Esclusa \(estanco\)/ })).toBeInTheDocument();
    expect(screen.getByText('Estanco · 2 puertas · se abre una por vez')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Portón Portón\. Abrir Puertas/ }));
    expect(onOpen).toHaveBeenLastCalledWith('puertas');
    await userEvent.click(screen.getAllByRole('button', { name: /^Lugar Planta\. Abrir Lugares/ })[0]);
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

  test('nombres largos completos, sin …', async () => {
    const largo = 'Ingreso Tesorería y Camioneros por Planta';
    mockPredio({
      areas: [...baseAreas.slice(0, 3), { id: 'tesoreria', name: 'Tesorería central de recuento' }],
      doors: [baseDoors[0], baseDoors[1], { ...baseDoors[2], name: largo }],
      airlockGroups: groups
    });
    render(<SiteMapSection onOpen={jest.fn()} />);
    await screen.findByText('No encontramos problemas.');
    const route = screen.getByRole('list', { name: 'Recorrido del predio' });
    expect(route.textContent).not.toMatch(/…/);
    expect(within(route).getByRole('button', { name: `Puerta ${largo}. Abrir Puertas` })).toHaveTextContent(largo);
    expect(within(route).getByRole('article', { name: 'Lugar Tesorería central de recuento' })).toBeInTheDocument();
  });

  test('estanco de 3 puertas y lugar al que se llega por dos caminos', async () => {
    mockPredio({
      areas: [
        { id: 'exterior', name: 'Exterior', fixed: true },
        { id: 'planta', name: 'Planta' },
        { id: 'esclusa', name: 'Esclusa' },
        { id: 'tesoreria', name: 'Tesorería' },
        { id: 'boveda', name: 'Bóveda' }
      ],
      doors: [
        ...baseDoors.slice(0, 2),
        { id: 'e2', name: 'Estanco tesorería', kind: 'door', active: true, readers: both, sides: side('esclusa', 'tesoreria') },
        { id: 'e3', name: 'Estanco bóveda', kind: 'door', active: true, readers: both, sides: side('esclusa', 'boveda') },
        { id: 'atajo', name: 'Atajo', kind: 'door', active: false, readers: both, sides: side('tesoreria', 'boveda') }
      ],
      airlockGroups: [{ id: 'g1', name: 'Tesoro', doorIds: ['e1', 'e2', 'e3'], outerDoorId: 'e1' }]
    });
    render(<SiteMapSection onOpen={jest.fn()} />);
    await screen.findByText('No encontramos problemas.');

    expect(screen.getByText('Estanco · 3 puertas · se abre una por vez')).toBeInTheDocument();
    expect(screen.getAllByRole('article', { name: 'Lugar Bóveda' })).toHaveLength(1);
    const tesoreria = screen.getByRole('article', { name: 'Lugar Tesorería' });
    expect(within(tesoreria).getByRole('button', { name: 'Puerta Atajo (apagada). Abrir Puertas' })).toBeInTheDocument();
    expect(within(tesoreria).getByText('(apagada)')).toBeInTheDocument();
    expect(within(tesoreria).getByText('Ese lugar ya figura más arriba')).toBeInTheDocument();
    expect(screen.getAllByText('Ese lugar ya figura más arriba')).toHaveLength(1);
  });

  test('contraer oculta los lugares de adentro y Expandir todo los vuelve a mostrar', async () => {
    mockPredio({ areas: baseAreas, doors: baseDoors, airlockGroups: groups });
    render(<SiteMapSection onOpen={jest.fn()} />);
    await screen.findByText('No encontramos problemas.');

    const toggle = screen.getByRole('button', { name: 'Contraer Planta' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Expandir Planta' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('article', { name: 'Lugar Esclusa' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Lugar Planta' })).toHaveTextContent('Estanco afuera');

    await userEvent.click(screen.getByRole('button', { name: 'Expandir todo' }));
    expect(screen.getByRole('article', { name: 'Lugar Tesorería' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Contraer todo' }));
    expect(screen.queryByRole('article', { name: 'Lugar Planta' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Lugar Exterior' })).toBeInTheDocument();
  });

  test('lugar sin conexión va a la sección final', async () => {
    mockPredio({
      areas: [...baseAreas, { id: 'taller', name: 'Taller' }, { id: 'patio', name: 'Patio' }],
      doors: [...baseDoors, { id: 't1', name: 'Taller patio', kind: 'door', active: true, readers: both, sides: side('taller', 'patio') }],
      airlockGroups: groups
    });
    render(<SiteMapSection onOpen={jest.fn()} />);
    const alone = await screen.findByRole('region', { name: 'Lugares sin conexión con el Exterior' });
    expect(within(alone).getByRole('article', { name: 'Lugar Patio' })).toBeInTheDocument();
    expect(within(alone).getByRole('article', { name: 'Lugar Taller' })).toBeInTheDocument();
    const route = screen.getByRole('list', { name: 'Recorrido del predio' });
    expect(within(route).queryByRole('article', { name: 'Lugar Taller' })).not.toBeInTheDocument();
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
});
