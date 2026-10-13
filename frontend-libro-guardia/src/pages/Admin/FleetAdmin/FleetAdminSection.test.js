import React from 'react';
import { render, screen } from '@testing-library/react';
import FleetAdminSection from './FleetAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockFleetUser = { role: 'admin', permissions: ['fleet.upload'] };
const mockFleetToast = { showSuccess: jest.fn(), showError: jest.fn(), setError: jest.fn() };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: mockFleetUser })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => mockFleetToast
}));

const { apiFetch } = require('../../../services/api');

describe('Flota interna', () => {
  it('explica móviles y choferes y el estado vacío', async () => {
    apiFetch.mockImplementation(async (path) => {
      if (String(path).includes('drivers')) return { drivers: [] };
      return { mobiles: [] };
    });
    render(<FleetAdminSection pendingAction={null} setPendingAction={jest.fn()} />);
    expect(screen.getByRole('heading', { name: 'Flota interna' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cargar móviles/ })).toBeInTheDocument();
    expect(await screen.findByText('Todavía no cargaste móviles')).toBeInTheDocument();
    expect(screen.getByText('Todavía no cargaste choferes')).toBeInTheDocument();
  });
});
