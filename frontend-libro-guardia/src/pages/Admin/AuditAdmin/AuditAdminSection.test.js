import React from 'react';
import { render, screen } from '@testing-library/react';
import AuditAdminSection from './AuditAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockAuditUser = { role: 'admin', permissions: ['audit.view'] };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ authToken: 'token-test', currentUser: mockAuditUser })
}));

const { apiFetch } = require('../../../services/api');

describe('Registro de cambios', () => {
  it('explica para qué sirve y el estado vacío', async () => {
    apiFetch.mockResolvedValue({ items: [] });
    render(<AuditAdminSection />);
    expect(screen.getByRole('heading', { name: 'Registro de cambios' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualizar' })).toBeInTheDocument();
    expect(await screen.findByText('Todavía no hay cambios')).toBeInTheDocument();
  });
});
