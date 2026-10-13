import React from 'react';
import { act, render } from '@testing-library/react';
import GuardiaControlCenter from './GuardiaControlCenter';
import LiveAlertsToaster from './LiveAlertsToaster';

const user = {
  id: 'guardia1',
  role: 'guardia',
  permissions: ['entries.view', 'entries.create', 'attendance.alerts.read', 'master.citaciones.read']
};

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'tok', currentUser: user })
}));
// La botonera tiene su propio polling (fuera de este cambio).
jest.mock('./DigitalDoorPanel', () => () => null);
jest.mock('../pages/Novedad/NovedadPage', () => () => null);

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

const countByPath = () => {
  const counts = {};
  global.fetch.mock.calls.forEach(([url]) => {
    const path = String(url).replace(/^.*\/api/, '').split('?')[0];
    counts[path] = (counts[path] || 0) + 1;
  });
  return counts;
};

describe('requests del inicio de guardia', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    global.fetch = jest.fn(async () => jsonResponse({ alerts: [] }));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const advance = async (ms) => {
    await act(async () => { jest.advanceTimersByTime(ms); });
  };

  it('primeros 10 s: KPIs una vez y alertas una vez; nada con la pestaña oculta', async () => {
    render(
      <>
        <LiveAlertsToaster />
        <GuardiaControlCenter showDoors={false} showNovedad={false} />
      </>
    );
    await advance(10000);
    expect(countByPath()).toEqual({
      '/guard/live-alerts': 1,
      '/guard/fleet-presence': 1,
      '/guard/attendance/missing': 1,
      '/guard/citados/today': 1,
      '/guard/authorizations': 1
    });

    // Minuto siguiente con la pestaña oculta: cero requests.
    const before = global.fetch.mock.calls.length;
    await act(async () => { setVisibility('hidden'); });
    await advance(60000);
    expect(global.fetch.mock.calls.length).toBe(before);

    // Al volver: un refresco inmediato de cada cosa.
    await act(async () => { setVisibility('visible'); });
    expect(global.fetch.mock.calls.length).toBe(before + 5);
  });
});
