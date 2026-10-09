import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import AppearanceAdminSection from './AppearanceAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockAppearanceUser = { role: 'admin', permissions: ['settings.permissions'] };
const mockAppearanceToast = { showSuccess: jest.fn(), showError: jest.fn() };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: mockAppearanceUser })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => mockAppearanceToast
}));

const { apiFetch } = require('../../../services/api');

describe('Datos de la empresa', () => {
  it('muestra el nombre y deja los colores en opciones avanzadas', async () => {
    apiFetch.mockResolvedValue({ appearance: {} });
    render(<AppearanceAdminSection />);
    expect(await screen.findByRole('heading', { name: 'Datos de la empresa' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Océano' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre de la empresa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Color principal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Opciones avanzadas' }));
    expect(screen.getByLabelText('Color principal')).toBeInTheDocument();
  });
});
