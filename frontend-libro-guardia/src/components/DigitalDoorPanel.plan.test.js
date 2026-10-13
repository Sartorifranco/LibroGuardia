import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DigitalDoorPanel from './DigitalDoorPanel';

const mockConfirm = jest.fn();

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: { id: 'g1', username: 'guardia', role: 'guardia', permissions: ['access.manual_open'] }
  })
}));

jest.mock('../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithReason: jest.fn() })
}));

jest.mock('../context/ToastContext', () => ({
  useToast: () => ({ showSuccess: jest.fn(), showError: jest.fn() })
}));

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const PLAN = {
  imageDataUrl: 'data:image/webp;base64,AAAA',
  width: 800,
  height: 600,
  version: 3
};

const forcedDoor = {
  id: 'd1',
  name: 'Portón',
  active: true,
  manualOpenAllowed: true,
  controllerId: 'ctrl-1',
  mapPos: { x: 0.2, y: 0.4 },
  live: { state: 'FORZADA' },
  health: { status: 'online' }
};

const unplacedDoor = { id: 'd2', name: 'Oficina', active: true, manualOpenAllowed: true };

function mockFetch({ plan = PLAN, doors = [forcedDoor, unplacedDoor] } = {}) {
  const calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, method: opts.method || 'GET' });
    if (path.includes('/guard/site-plan/meta')) return json({ version: plan ? plan.version : null });
    if (path.includes('/guard/site-plan')) return json({ plan });
    if (path.includes('/remote-open')) return json({ command: { id: 'c1', status: 'done' } }, 202);
    if (path.includes('/guard/commands/')) return json({ status: 'done' });
    if (path.includes('/guard/doors')) return json({ doors });
    return json({});
  });
  return calls;
}

describe('vista Plano del panel de puertas', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.localStorage.clear();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('sin plano no aparece el selector Lista | Plano', async () => {
    mockFetch({ plan: null });
    render(<DigitalDoorPanel canManualOpen pollSeconds={0} />);
    expect(await screen.findByText('Portón')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/guard/site-plan/meta'),
      expect.anything()
    ));
    expect(screen.queryByRole('button', { name: 'Plano' })).not.toBeInTheDocument();
  });

  test('sin puertas ubicadas no aparece el selector aunque haya plano', async () => {
    mockFetch({ doors: [unplacedDoor] });
    render(<DigitalDoorPanel canManualOpen pollSeconds={0} />);
    expect(await screen.findByText('Oficina')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/guard/site-plan'),
      expect.anything()
    ));
    expect(screen.queryByRole('button', { name: 'Plano' })).not.toBeInTheDocument();
  });

  test('con plano: punto rojo para la puerta forzada y Abrir puerta usa la misma apertura', async () => {
    const calls = mockFetch();
    render(<DigitalDoorPanel canManualOpen pollSeconds={0} />);

    const planBtn = await screen.findByRole('button', { name: 'Plano' });
    expect(screen.getByRole('button', { name: 'Lista' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(planBtn);
    expect(planBtn).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('mss-guard-doors-view')).toBe('plan');

    const dot = screen.getByTestId('guard-plan-dot-d1');
    expect(dot).toHaveClass('guard-plan__dot--red');
    expect(screen.getByText('1 puerta no está en el plano.')).toBeInTheDocument();

    fireEvent.click(dot);
    expect(screen.getByText('Forzada')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir puerta' }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(calls.some((c) => c.path.includes('/guard/doors/d1/remote-open') && c.method === 'POST')).toBe(true));
  });

  test('tocar un punto abre la ventanita junto al punto y Abrir puerta pide la apertura', async () => {
    window.localStorage.setItem('mss-guard-doors-view', 'plan');
    const calls = mockFetch();
    render(<DigitalDoorPanel canManualOpen pollSeconds={0} />);

    const dot = await screen.findByTestId('guard-plan-dot-d1');
    fireEvent.click(dot);
    const popover = screen.getByRole('dialog', { name: 'Puerta Portón' });
    expect(popover).toHaveClass('guard-plan__popover');
    expect(popover.closest('.guard-plan__stage')).not.toBeNull();
    const openBtn = screen.getByRole('button', { name: 'Abrir puerta' });
    expect(popover).toContainElement(openBtn);
    expect(openBtn).toHaveFocus();

    fireEvent.click(openBtn);
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(calls.some((c) => c.path.includes('/guard/doors/d1/remote-open') && c.method === 'POST')).toBe(true));
  });

  test('Escape, tocar el mismo punto o el plano cierran la ventanita', async () => {
    window.localStorage.setItem('mss-guard-doors-view', 'plan');
    mockFetch();
    render(<DigitalDoorPanel canManualOpen pollSeconds={0} />);

    const dot = await screen.findByTestId('guard-plan-dot-d1');
    fireEvent.click(dot);
    expect(screen.getByRole('dialog', { name: 'Puerta Portón' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(dot);
    fireEvent.click(dot);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(dot);
    fireEvent.click(document.querySelector('.guard-plan__stage'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('el texto de ayuda de nombres se va al acercar al 200 %', async () => {
    window.localStorage.setItem('mss-guard-doors-view', 'plan');
    mockFetch();
    render(<DigitalDoorPanel canManualOpen pollSeconds={0} />);

    await screen.findByTestId('guard-plan-dot-d1');
    const hint = 'Acercá el plano para ver los nombres de las puertas.';
    const stage = document.querySelector('.guard-plan__stage');
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(stage).not.toHaveClass('guard-plan__stage--labels');

    fireEvent.click(screen.getByRole('button', { name: 'Acercar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Acercar' }));
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    expect(stage).toHaveClass('guard-plan__stage--labels');
  });

  test('recuerda la vista Plano y el enlace vuelve a la lista', async () => {
    window.localStorage.setItem('mss-guard-doors-view', 'plan');
    mockFetch();
    render(<DigitalDoorPanel canManualOpen pollSeconds={0} />);

    expect(await screen.findByTestId('guard-plan-dot-d1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ver la lista' }));
    expect(screen.getByText('Oficina')).toBeInTheDocument();
    expect(screen.queryByTestId('guard-plan-dot-d1')).not.toBeInTheDocument();
  });
});
