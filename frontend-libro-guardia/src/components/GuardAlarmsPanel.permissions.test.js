import React from 'react';
import { render, screen } from '@testing-library/react';
import { GuardAlarmsProvider } from '../context/GuardAlarmsContext';
import GuardAlarmsPanel from './GuardAlarmsPanel';

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: { id: 'g1', username: 'guardia', role: 'guardia', permissions: ['alarmas.ver'] }
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

test('sin permiso de reconocer no muestra Reconocer ni Cerrar', async () => {
  global.fetch = jest.fn(async () => json({
    alerts: [{ id: 'a1', kind: 'alarm', type: 'duress', meta: { doorId: 'p1' } }]
  }));

  render(
    <GuardAlarmsProvider>
      <GuardAlarmsPanel />
    </GuardAlarmsProvider>
  );

  expect(await screen.findByRole('heading', { name: 'Coacción' })).toBeInTheDocument();
  expect(screen.getByText('No confrontes a la persona. Avisá en silencio a supervisión.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reconocer' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cerrar' })).not.toBeInTheDocument();
});
