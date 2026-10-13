import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
    <MemoryRouter>
      <ConfirmProvider>
        <DoorsAdminPanel
          authToken="token-test"
          pendingAction={null}
          onPending={async (_id, fn) => { await fn(); }}
          onSuccess={jest.fn()}
          onError={jest.fn()}
        />
      </ConfirmProvider>
    </MemoryRouter>
  );
}

const NEW_PLACE = '+ Crear un lugar nuevo…';

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

  test('crear un lugar desde la puerta lo deja elegido en ese lado', async () => {
    const posts = [];
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/areas' && opts.method === 'POST') {
        posts.push(opts.body);
        return { message: 'Lugar creado.', area: { id: 'tesoreria', name: opts.body.name } };
      }
      if (path === '/admin/areas') return areas;
      if (path === '/admin/doors/physical-status') return { doors: [] };
      if (path === '/admin/devices') return { devices: [] };
      if (path === '/admin/doors-config') return { config: { doors: [], airlockGroups: [] }, globalAccess: {} };
      return {};
    });

    renderDoors();
    await userEvent.click(await screen.findByRole('button', { name: 'Crear puerta' }));
    expect(await screen.findAllByRole('option', { name: 'Planta' })).not.toHaveLength(0);
    const from = screen.getByLabelText('¿Desde dónde se llega a esta puerta?');
    const to = screen.getByLabelText('¿A qué lugar se entra al pasarla?');
    const fromOptions = within(from).getAllByRole('option');
    const toOptions = within(to).getAllByRole('option');
    expect(fromOptions[fromOptions.length - 1]).toHaveTextContent(NEW_PLACE);
    expect(toOptions[toOptions.length - 1]).toHaveTextContent(NEW_PLACE);
    expect(screen.getByRole('link', { name: 'Puertas y equipos → Lugares' })).toHaveAttribute('href', '/admin/lugares');

    await userEvent.selectOptions(to, 'planta');
    await userEvent.selectOptions(to, NEW_PLACE);
    const placeDialog = await screen.findByRole('dialog', { name: 'Crear un lugar nuevo' });
    expect(screen.getByRole('dialog', { name: 'Nueva puerta' })).toBeInTheDocument();
    expect(placeDialog).toHaveAttribute('data-size', 'sm');
    expect(screen.getByText('Un lugar es una zona del predio separada por puertas.')).toBeInTheDocument();
    expect(to).toHaveValue('planta');

    await userEvent.click(within(placeDialog).getByRole('button', { name: 'Crear' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/al menos 2 letras/);

    const name = within(placeDialog).getByLabelText('Nombre del lugar');
    await userEvent.type(name, 'Planta');
    await userEvent.click(within(placeDialog).getByRole('button', { name: 'Crear' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Ya existe un lugar con ese nombre.');

    await userEvent.clear(name);
    await userEvent.type(name, 'Tesorería');
    await userEvent.click(within(placeDialog).getByRole('button', { name: 'Crear' }));

    await waitFor(() => expect(to).toHaveValue('tesoreria'));
    expect(posts).toEqual([{ name: 'Tesorería' }]);
    expect(from).toHaveValue('exterior');
    expect(screen.queryByRole('dialog', { name: 'Crear un lugar nuevo' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Nueva puerta' })).toBeInTheDocument();
    expect(within(to).getByRole('option', { name: 'Tesorería' }).selected).toBe(true);
  });

  test('cancelar el lugar nuevo vuelve al valor anterior', async () => {
    renderDoors();
    await userEvent.click(await screen.findByRole('button', { name: 'Crear puerta' }));
    expect(await screen.findAllByRole('option', { name: 'Estacionamiento' })).not.toHaveLength(0);
    const from = screen.getByLabelText('¿Desde dónde se llega a esta puerta?');
    await userEvent.selectOptions(from, 'estacionamiento');
    await userEvent.selectOptions(from, NEW_PLACE);
    const placeDialog = await screen.findByRole('dialog', { name: 'Crear un lugar nuevo' });
    await userEvent.type(within(placeDialog).getByLabelText('Nombre del lugar'), 'Oficinas');
    await userEvent.click(within(placeDialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog', { name: 'Crear un lugar nuevo' })).not.toBeInTheDocument();
    expect(from).toHaveValue('estacionamiento');
    expect(screen.getByRole('dialog', { name: 'Nueva puerta' })).toBeInTheDocument();
  });

  test('Escape cierra solo el lugar nuevo y el foco vuelve al select', async () => {
    renderDoors();
    await userEvent.click(await screen.findByRole('button', { name: 'Crear puerta' }));
    expect(await screen.findAllByRole('option', { name: 'Planta' })).not.toHaveLength(0);
    const to = screen.getByLabelText('¿A qué lugar se entra al pasarla?');
    await userEvent.selectOptions(to, 'planta');
    await userEvent.selectOptions(to, NEW_PLACE);
    expect(await screen.findByRole('dialog', { name: 'Crear un lugar nuevo' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Crear un lugar nuevo' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Nueva puerta' })).toBeInTheDocument();
    expect(screen.queryByText('¿Descartar los cambios?')).not.toBeInTheDocument();
    expect(to).toHaveValue('planta');
    expect(to).toHaveFocus();
  });

  test('pregunta antes de ir a Lugares si la puerta tiene cambios', async () => {
    renderDoors();
    await userEvent.click(await screen.findByRole('button', { name: 'Crear puerta' }));
    await userEvent.click(screen.getByRole('link', { name: 'Puertas y equipos → Lugares' }));
    expect(screen.getByRole('dialog', { name: 'Cambios sin guardar' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Seguir acá' }));
    expect(screen.queryByRole('dialog', { name: 'Cambios sin guardar' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Nueva puerta' })).toBeInTheDocument();
    expect(screen.getByLabelText('¿Desde dónde se llega a esta puerta?')).toHaveValue('exterior');
  });
});

describe('una puerta en estancos', () => {
  const saved = [];
  const sides = { in: { zoneFrom: 'exterior', zoneTo: 'planta' }, out: { zoneFrom: 'planta', zoneTo: 'exterior' } };
  const groups = [
    { id: 'estanco-guardia', name: 'Estanco Guardia', doorIds: ['guardia', 'teso', 'depo'], outerDoorId: 'guardia', enabled: true, mode: 'sequential_closed', transitTimeoutMs: 90000 },
    { id: 'estanco-playa', name: 'Estanco Playa', doorIds: ['playa', 'depo'], outerDoorId: 'playa', enabled: true, mode: 'sequential_closed' }
  ];

  beforeEach(() => {
    saved.length = 0;
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/areas') return areas;
      if (path === '/admin/doors/physical-status') return { doors: [] };
      if (path === '/admin/devices') return { devices: [] };
      if (path === '/admin/lectores') return { lectores: [] };
      if (path === '/admin/doors-config' && opts.method === 'PUT') {
        saved.push(opts.body);
        return { config: { doors: opts.body.doors, airlockGroups: opts.body.airlockGroups, defaultDoorId: opts.body.defaultDoorId }, globalAccess: {} };
      }
      if (path === '/admin/doors-config') {
        return {
          config: {
            doors: [
              { id: 'guardia', name: 'Puerta Guardia', doorCode: 'P1', sides, airlockGroupId: 'estanco-guardia', airlockRole: 'outer' },
              { id: 'teso', name: 'Ingreso Teso y Camioneros', doorCode: 'P2', sides, airlockGroupId: 'estanco-guardia', airlockRole: 'inner' },
              { id: 'depo', name: 'Ingreso Depositario', doorCode: 'P3', sides, airlockGroupId: 'estanco-guardia', airlockRole: 'inner' },
              { id: 'playa', name: 'Portón Playa', doorCode: 'P4', sides, airlockGroupId: 'estanco-playa', airlockRole: 'outer' },
              { id: 'oficina', name: 'Oficina', doorCode: 'P5', sides }
            ],
            airlockGroups: groups,
            defaultDoorId: 'guardia'
          },
          globalAccess: {}
        };
      }
      return {};
    });
  });

  const openCard = async (name) => {
    const card = (await screen.findByRole('heading', { name })).closest('article');
    await userEvent.click(within(card).getByRole('button', { name: 'Configurar' }));
    return screen.findByRole('dialog');
  };

  test('muestra los estancos solo para leer y guardar no los cambia', async () => {
    renderDoors();
    const dialog = await openCard('Puerta Guardia');
    expect(within(dialog).getByText('Forma parte de:')).toBeInTheDocument();
    expect(within(dialog).getByText('Estanco Guardia (con Ingreso Teso y Camioneros e Ingreso Depositario)')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Editar estancos' })).toHaveAttribute('href', '/admin/estancos');
    expect(within(dialog).queryByText(/La otra puerta/)).not.toBeInTheDocument();

    const name = within(dialog).getByPlaceholderText('Portón de clientes');
    fireEvent.change(name, { target: { value: 'Guardia principal' } });
    expect(name).toHaveValue('Guardia principal');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].airlockGroups).toEqual(groups);
    const byId = Object.fromEntries(saved[0].doors.map((door) => [door.id, door]));
    expect(byId.guardia).toMatchObject({ name: 'Guardia principal', airlockGroupId: 'estanco-guardia', airlockRole: 'outer' });
    expect(byId.depo).toMatchObject({ airlockGroupId: 'estanco-guardia', airlockRole: 'inner' });
    expect(byId.oficina.airlockGroupId).toBeNull();
  });

  test('una puerta en dos estancos muestra una línea por cada uno', async () => {
    renderDoors();
    const dialog = await openCard('Ingreso Depositario');
    expect(within(dialog).getByText('Estanco Guardia (con Puerta Guardia e Ingreso Teso y Camioneros)')).toBeInTheDocument();
    expect(within(dialog).getByText('Estanco Playa (con Portón Playa)')).toBeInTheDocument();
  });

  test('una puerta sin estanco lo dice', async () => {
    renderDoors();
    const dialog = await openCard('Oficina');
    expect(within(dialog).getByText('No forma parte de ningún estanco.')).toBeInTheDocument();
  });

  test('borrar una puerta la saca de sus estancos y avisa cuáles se borran', async () => {
    renderDoors();
    const dialog = await openCard('Ingreso Depositario');
    await userEvent.click(within(dialog).getByRole('button', { name: /Eliminar puerta/ }));
    expect(await screen.findByText(/El estanco Estanco Playa se borra/)).toBeInTheDocument();
    expect(screen.getByText(/Sale del estanco Estanco Guardia/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].airlockGroups).toEqual([
      { ...groups[0], doorIds: ['guardia', 'teso'] }
    ]);
    expect(saved[0].doors.find((door) => door.id === 'playa').airlockGroupId).toBeNull();
  });
});

describe('aviso en una puerta sin lugares distintos', () => {
  beforeEach(() => {
    apiFetch.mockImplementation(async (path) => {
      if (path === '/admin/areas') return areas;
      if (path === '/admin/doors/physical-status') return { doors: [] };
      if (path === '/admin/devices') return { devices: [] };
      if (path === '/admin/doors-config') {
        return {
          config: {
            doors: [
              {
                id: 'porton',
                name: 'Portón de clientes',
                doorCode: 'P1',
                sides: {
                  in: { zoneFrom: 'exterior', zoneTo: 'planta' },
                  out: { zoneFrom: 'planta', zoneTo: 'exterior' }
                }
              },
              {
                id: 'vieja',
                name: 'Puerta vieja',
                doorCode: 'P2',
                sides: { in: { zoneFrom: 'planta', zoneTo: 'planta' } }
              },
              { id: 'vacia', name: 'Sin lados', doorCode: 'P3' }
            ],
            airlockGroups: []
          },
          globalAccess: {}
        };
      }
      return {};
    });
  });

  test('la tarjeta avisa si faltan los lugares o son el mismo', async () => {
    renderDoors();
    const vieja = (await screen.findByRole('heading', { name: 'Puerta vieja' })).closest('article');
    const vacia = screen.getByRole('heading', { name: 'Sin lados' }).closest('article');
    const porton = screen.getByRole('heading', { name: 'Portón de clientes' }).closest('article');
    expect(within(vieja).getByText('Falta indicar qué lugares conecta')).toHaveClass('is-warn');
    expect(within(vacia).getByText('Falta indicar qué lugares conecta')).toHaveClass('is-warn');
    expect(within(porton).queryByText('Falta indicar qué lugares conecta')).not.toBeInTheDocument();
  });
});
