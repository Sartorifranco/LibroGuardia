import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuardAlarmsProvider } from '../context/GuardAlarmsContext';
import GuardAlarmsPanel from './GuardAlarmsPanel';

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: {
      id: 'g1',
      username: 'guardia',
      role: 'guardia',
      permissions: ['alarmas.ver', 'alarmas.reconocer', 'entries.view']
    }
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

describe('reconocer alarma', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('pide una nota y la envía al reconocer', async () => {
    global.fetch = jest.fn(async (url) => {
      const path = String(url);
      if (path.includes('/ack')) return json({ ok: true });
      if (path.includes('/guard/alarms') && !path.includes('/ack')) {
        return json({
          alerts: [{
            id: 'a1',
            kind: 'alarm',
            type: 'door_forced',
            doorName: 'Principal'
          }]
        });
      }
      return json({});
    });

    render(
      <GuardAlarmsProvider>
        <GuardAlarmsPanel />
      </GuardAlarmsProvider>
    );

    expect(await screen.findByRole('heading', { name: 'Puerta forzada' })).toBeInTheDocument();
    expect(screen.getByText('Andá a esa puerta y fijate que nadie esté pasando.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reconocer' }));
    const note = screen.getByRole('textbox');
    await userEvent.type(note, 'vi');
    expect(screen.getByRole('button', { name: 'Reconocer' })).toBeDisabled();
    await userEvent.type(note, 'sto en puerta');
    await userEvent.click(screen.getByRole('button', { name: 'Reconocer' }));

    expect(await screen.findByText('No hay alarmas abiertas.')).toBeInTheDocument();
    const ackCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/ack'));
    expect(ackCall).toBeTruthy();
    expect(ackCall[1].method).toBe('POST');
    expect(JSON.parse(ackCall[1].body)).toEqual({ note: 'visto en puerta' });
  });

  test('cerrar manda la nota y close', async () => {
    global.fetch = jest.fn(async (url) => {
      const path = String(url);
      if (path.includes('/ack')) return json({ ok: true });
      if (path.includes('/guard/alarms')) {
        return json({
          alerts: [{ id: 'a1', kind: 'alarm', type: 'door_forced', meta: { doorId: 'p1' } }]
        });
      }
      return json({});
    });

    render(
      <GuardAlarmsProvider>
        <GuardAlarmsPanel />
      </GuardAlarmsProvider>
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar' }));
    await userEvent.type(screen.getByRole('textbox'), 'ya quedó bien');
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));

    await screen.findByText('No hay alarmas abiertas.');
    const ackCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/ack'));
    expect(JSON.parse(ackCall[1].body)).toEqual({ note: 'ya quedó bien', close: true });
  });

  test('el filtro de recientes pide status=recent', async () => {
    global.fetch = jest.fn(async () => json({ alerts: [] }));
    render(
      <GuardAlarmsProvider>
        <GuardAlarmsPanel />
      </GuardAlarmsProvider>
    );
    await screen.findByText('No hay alarmas abiertas.');
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'recent');
    await screen.findByText('No hay alarmas recientes.');
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('status=recent'))).toBe(true);
  });
});
