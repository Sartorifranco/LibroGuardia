import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { RuntimeProvider, useRuntime } from './RuntimeContext';
import RuntimeModeBadge from '../components/RuntimeModeBadge';

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function ModeProbe() {
  const { mode, status } = useRuntime();
  return <span>{status === 'ready' ? mode : 'cargando'}</span>;
}

describe('detección de modo', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('si /runtime responde mode lan, queda en planta y muestra Red local', async () => {
    global.fetch = jest.fn(async () => json({
      mode: 'lan',
      siteId: 'principal',
      hubId: 'hub-1',
      configVersion: 3,
      cloudOnline: true,
      capabilities: ['auth', 'doors', 'open', 'entries', 'alarms', 'live', 'scan']
    }));

    render(
      <RuntimeProvider>
        <ModeProbe />
        <RuntimeModeBadge />
      </RuntimeProvider>
    );

    expect(await screen.findByText('lan')).toBeInTheDocument();
    const badge = screen.getByText('Red local');
    expect(badge).toHaveClass('runtime-mode-badge--on');
  });

  test('si la nube no tiene internet, el indicador avisa en amarillo', async () => {
    global.fetch = jest.fn(async () => json({
      mode: 'lan',
      cloudOnline: false,
      capabilities: ['doors']
    }));

    render(
      <RuntimeProvider>
        <RuntimeModeBadge />
      </RuntimeProvider>
    );

    const badge = await screen.findByText('Red local · sin internet');
    expect(badge).toHaveClass('runtime-mode-badge--off');
  });

  test('404 en /runtime es modo nube y no muestra indicador', async () => {
    global.fetch = jest.fn(async () => json({ message: 'No existe' }, 404));

    render(
      <RuntimeProvider>
        <ModeProbe />
        <RuntimeModeBadge />
      </RuntimeProvider>
    );

    expect(await screen.findByText('cloud')).toBeInTheDocument();
    expect(screen.queryByText(/Red local/)).not.toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });
});
