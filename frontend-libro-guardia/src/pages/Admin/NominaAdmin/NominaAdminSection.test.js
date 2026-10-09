import React from 'react';
import { render, screen } from '@testing-library/react';
import NominaAdminSection from './NominaAdminSection';
import { summarizeNominaChange } from './nominaDiff';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockNominaUser = {
  role: 'admin',
  permissions: ['master.nomina.read', 'master.nomina.write']
};
const mockNominaToast = { showSuccess: jest.fn(), showError: jest.fn(), setError: jest.fn() };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: mockNominaUser })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => mockNominaToast
}));

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: jest.fn() })
}));

const { apiFetch } = require('../../../services/api');

describe('Importar nómina', () => {
  it('resume altas, bajas y cambios por DNI', () => {
    const summary = summarizeNominaChange(
      [
        { name: 'Ana Pérez', idNumber: '30111222', active: true },
        { name: 'Luis Gómez', idNumber: '20999888', active: true }
      ],
      [
        { Usuario: 'Ana Lopez', DNI: '30111222' },
        { Usuario: 'Nueva Persona', DNI: '40111000' }
      ]
    );
    expect(summary).toEqual({ altas: 1, bajas: 1, cambios: 1, sinDni: 0 });
  });

  it('muestra el asistente de tres pasos y la planilla modelo', async () => {
    apiFetch.mockResolvedValue({ personal: [] });
    render(<NominaAdminSection pendingAction={null} setPendingAction={jest.fn()} runAction={jest.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Importar nómina' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByText('Elegí el archivo')).toBeInTheDocument();
    expect(screen.getByText('Revisá lo que va a cambiar')).toBeInTheDocument();
    expect(screen.getByText('Confirmar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Descargar planilla modelo/ })).toBeInTheDocument();
    expect(await screen.findByText('Todavía no cargaste la nómina')).toBeInTheDocument();
  });
});
