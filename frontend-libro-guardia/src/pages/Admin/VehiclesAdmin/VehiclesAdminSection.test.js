import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import VehiclesAdminSection from './VehiclesAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockVehicleUser = { role: 'admin', permissions: ['master.vehicles.write', 'master.vehicles.read'] };
const mockVehicleToast = { showSuccess: jest.fn(), showError: jest.fn(), setError: jest.fn() };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: mockVehicleUser })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => mockVehicleToast
}));

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: jest.fn() })
}));

const { apiFetch } = require('../../../services/api');

describe('Vehículos', () => {
  it('explica para qué sirve y el estado vacío', async () => {
    apiFetch.mockResolvedValue({ vehicles: [] });
    render(<VehiclesAdminSection pendingAction={null} runAction={jest.fn()} setPendingAction={jest.fn()} />);
    expect(screen.getByRole('heading', { name: 'Vehículos' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Agregar vehículo/ }));
    expect(screen.getByLabelText('Patente')).toBeInTheDocument();
    expect(screen.getByText('Todavía no cargaste vehículos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Opciones avanzadas' })).toBeInTheDocument();
  });
});
