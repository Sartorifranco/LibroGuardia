import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SitePlanSection from './SitePlanSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: { role: 'admin', permissions: ['access.doors.manage'] } })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({ showSuccess: jest.fn(), showError: jest.fn() })
}));

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: jest.fn(async () => true) })
}));

const { apiFetch } = require('../../../services/api');

const PLAN = { imageDataUrl: 'data:image/webp;base64,AAAA', width: 800, height: 400, version: 3, updatedAt: null };

const baseDoors = () => ([
  { id: 'guardia', name: 'Puerta Guardia', kind: 'door', mapPos: { x: 0.1, y: 0.2 } },
  { id: 'playa', name: 'Portón Playa', kind: 'gate', airlockGroupId: 'estanco-playa' },
  { id: 'teso', name: 'Ingreso Tesorería', kind: 'door', mapPos: null }
]);

const setup = ({ plan = PLAN, doors = baseDoors() } = {}) => {
  const state = { doors, puts: [], planGets: 0 };
  apiFetch.mockImplementation(async (path, opts = {}) => {
    if (path === '/admin/site-plan/meta') return { version: plan ? plan.version : null };
    if (path === '/admin/site-plan') {
      state.planGets += 1;
      return { plan };
    }
    if (path === '/admin/doors-config' && opts.method === 'PUT') {
      state.puts.push(opts.body);
      state.doors = opts.body.doors;
      return { config: { doors: opts.body.doors, defaultDoorId: opts.body.defaultDoorId } };
    }
    if (path === '/admin/doors-config') {
      return { config: { doors: state.doors, airlockGroups: [], defaultDoorId: 'guardia' }, meta: {} };
    }
    return {};
  });
  return state;
};

beforeEach(() => {
  window.localStorage.clear();
  apiFetch.mockReset();
});

describe('Plano del predio', () => {
  test('sin plano muestra el aviso para subirlo', async () => {
    setup({ plan: null });
    render(<SitePlanSection />);
    expect(await screen.findByText('Subí el plano de la planta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subir plano' })).toBeInTheDocument();
    expect(screen.getByText(/Ver dónde está cada puerta sobre el plano real del predio/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith('/admin/site-plan', expect.anything());
  });

  test('lista las puertas sin ubicar', async () => {
    setup();
    render(<SitePlanSection />);
    const side = await screen.findByRole('complementary', { name: 'Puertas sin ubicar' });
    const items = within(side).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Portón Playa'),
      expect.stringContaining('Ingreso Tesorería')
    ]);
    expect(within(side).queryByText('Puerta Guardia')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Puerta Guardia' })).toHaveClass('site-plan__dot');
    expect(screen.getByRole('button', { name: 'Puerta Guardia' })).not.toHaveClass('is-gate');
  });

  test('ubicar una puerta guarda mapPos leyendo antes la config actual', async () => {
    const state = setup();
    render(<SitePlanSection />);
    const side = await screen.findByRole('complementary', { name: 'Puertas sin ubicar' });
    await userEvent.click(within(side).getByRole('button', { name: /Ingreso Tesorería/ }));
    expect(screen.getByText('Tocá en el plano dónde está «Ingreso Tesorería»')).toBeInTheDocument();

    const img = screen.getByAltText('Plano del predio');
    img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120 });
    fireEvent.click(img, { clientX: 60, clientY: 45 });

    await waitFor(() => expect(state.puts).toHaveLength(1));
    const body = state.puts[0];
    expect(body.defaultDoorId).toBe('guardia');
    expect(body.doors.find((door) => door.id === 'teso').mapPos).toEqual({ x: 0.25, y: 0.25 });
    expect(body.doors.find((door) => door.id === 'guardia').mapPos).toEqual({ x: 0.1, y: 0.2 });
    expect(await screen.findByRole('button', { name: 'Ingreso Tesorería' })).toHaveClass('site-plan__dot');
    expect(screen.queryByText(/Tocá en el plano dónde está/)).not.toBeInTheDocument();
  });

  test('tocar un punto deja moverlo o quitarlo del plano', async () => {
    const state = setup();
    render(<SitePlanSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Puerta Guardia' }));
    const panel = screen.getByRole('region', { name: 'Puerta Puerta Guardia' });
    expect(within(panel).getByRole('button', { name: 'Mover' })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Quitar del plano' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0].doors.find((door) => door.id === 'guardia').mapPos).toBeNull();
  });

  test('usa el plano guardado en el navegador si la versión no cambió', async () => {
    window.localStorage.setItem('mss-site-plan:v3', JSON.stringify(PLAN));
    const state = setup();
    render(<SitePlanSection />);
    expect(await screen.findByAltText('Plano del predio')).toBeInTheDocument();
    expect(state.planGets).toBe(0);
  });

  test('baja el plano y lo guarda si la versión cambió', async () => {
    window.localStorage.setItem('mss-site-plan:v2', JSON.stringify({ ...PLAN, version: 2 }));
    const state = setup();
    render(<SitePlanSection />);
    expect(await screen.findByAltText('Plano del predio')).toBeInTheDocument();
    expect(state.planGets).toBe(1);
    expect(window.localStorage.getItem('mss-site-plan:v2')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('mss-site-plan:v3')).version).toBe(3);
  });
});
