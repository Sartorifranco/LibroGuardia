import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import DigitalDoorPanel from './DigitalDoorPanel';
import { RuntimeProvider } from '../context/RuntimeContext';
import { HubLiveProvider } from '../context/HubLiveContext';

jest.setTimeout(20000);

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: {
      id: 'g1',
      username: 'guardia',
      role: 'guardia',
      permissions: ['access.manual_open', 'guard.doors.panel', 'puertas.estanco.forzar']
    }
  })
}));

jest.mock('../context/ConfirmContext', () => ({
  useConfirm: () => ({
    confirm: jest.fn(() => Promise.resolve(true)),
    confirmWithReason: jest.fn()
  })
}));

jest.mock('../context/ToastContext', () => ({
  useToast: () => ({
    showSuccess: jest.fn(),
    showError: jest.fn()
  })
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

class MockEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    MockEventSource.instances.push(this);
    queueMicrotask(() => {
      if (!this.closed && typeof this.onopen === 'function') this.onopen();
    });
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  close() {
    this.closed = true;
  }

  emit(type, data) {
    const ev = { data: JSON.stringify(data) };
    (this.listeners[type] || []).forEach((fn) => fn(ev));
  }
}

const closedDoor = {
  id: 'd1',
  name: 'Principal',
  active: true,
  manualOpenAllowed: true,
  live: { state: 'SEGURA' },
  health: { status: 'online' }
};

describe('puertas en planta y apertura remota', () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;

  beforeEach(() => {
    MockEventSource.instances = [];
    global.EventSource = MockEventSource;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
  });

  test('un evento en vivo pasa la puerta de Cerrada a Destrabada y luego a Abierta', async () => {
    global.fetch = jest.fn(async (url) => {
      const path = String(url);
      if (path.includes('/runtime')) {
        return json({
          mode: 'lan',
          cloudOnline: true,
          capabilities: ['doors', 'open', 'live'],
          siteId: 'principal',
          hubId: 'hub-1',
          configVersion: 1
        });
      }
      if (path.includes('/guard/doors')) {
        return json({ doors: [closedDoor] });
      }
      return json({});
    });

    render(
      <RuntimeProvider>
        <HubLiveProvider>
          <DigitalDoorPanel canManualOpen botoneraMode pollSeconds={0} />
        </HubLiveProvider>
      </RuntimeProvider>
    );

    expect(await screen.findByText('Cerrada')).toBeInTheDocument();
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    const source = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(source.url).toContain('/live?token=tok');

    act(() => {
      source.emit('door', {
        id: 'd1',
        live: { state: 'DESBLOQUEADA' },
        health: { status: 'online' }
      });
    });

    expect(screen.getByText('Destrabada')).toBeInTheDocument();
    expect(screen.getByText('Destrabada').closest('[role="status"]')).toHaveClass('door-live--open');
    expect(screen.queryByText('Cerrada')).not.toBeInTheDocument();

    act(() => {
      source.emit('door', {
        doorId: 'd1',
        state: 'ABIERTA_AUT',
        dps: 'open',
        bond: 'released',
        since: 1
      });
    });

    expect(screen.getByText('Abierta')).toBeInTheDocument();
    expect(screen.queryByText('Destrabada')).not.toBeInTheDocument();
  });

  test('la apertura remota consulta el comando hasta que termina', async () => {
    let commandReads = 0;
    global.fetch = jest.fn(async (url) => {
      const path = String(url);
      if (path.includes('/remote-open')) {
        return json({ command: { id: 'c1', status: 'pending' } }, 202);
      }
      if (path.includes('/guard/commands/')) {
        commandReads += 1;
        if (commandReads === 1) return json({ status: 'pending' });
        return json({ status: 'done' });
      }
      if (path.includes('/guard/doors')) {
        return json({
          doors: [{
            id: 'd1',
            name: 'Principal',
            active: true,
            manualOpenAllowed: true,
            controllerId: 'ctrl-1'
          }]
        });
      }
      return json({});
    });

    render(<DigitalDoorPanel canManualOpen botoneraMode pollSeconds={0} />);

    expect(await screen.findByRole('button', { name: 'Abrir' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));

    expect(await screen.findByText('Enviando…')).toBeInTheDocument();
    expect(await screen.findByText('Puerta abierta', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(commandReads).toBeGreaterThanOrEqual(2);
  });
});
