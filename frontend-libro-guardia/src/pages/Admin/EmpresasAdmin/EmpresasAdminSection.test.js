import React from 'react';
import { render, screen } from '@testing-library/react';
import EmpresasAdminSection from './EmpresasAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockEmpresaUser = { role: 'admin', permissions: ['empresas.manage'] };
const mockEmpresaToast = { showSuccess: jest.fn(), showError: jest.fn() };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: mockEmpresaUser })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => mockEmpresaToast
}));

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: jest.fn() })
}));

const { apiFetch } = require('../../../services/api');

describe('Empresas y responsables', () => {
  it('explica para qué sirve y el estado vacío', async () => {
    apiFetch.mockResolvedValue({ empresas: [] });
    render(<EmpresasAdminSection pendingAction={null} runAction={jest.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Empresas y responsables' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByLabelText('Mails de la empresa', { selector: 'input, textarea' })).toBeInTheDocument();
    expect(await screen.findByText('Todavía no cargaste empresas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar empresa' })).toBeInTheDocument();
  });
});
