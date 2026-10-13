import React from 'react';
import { render, screen } from '@testing-library/react';
import ActivityAdminSection from './ActivityAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockActivityUser = { role: 'admin', permissions: ['audit.view'] };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: mockActivityUser })
}));

const { apiFetch } = require('../../../services/api');

describe('Registro de cambios reciente', () => {
  it('muestra el resumen y el estado vacío', async () => {
    apiFetch.mockResolvedValue({ activity: [] });
    render(<ActivityAdminSection />);
    expect(screen.getByRole('heading', { name: 'Registro de cambios' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(await screen.findByText(/Todavía no hay cambios/)).toBeInTheDocument();
  });
});
