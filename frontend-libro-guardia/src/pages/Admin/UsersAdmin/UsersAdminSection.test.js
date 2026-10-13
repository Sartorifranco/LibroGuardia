import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UsersAdminSection from './UsersAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockUsersActor = {
  id: 'me',
  role: 'admin',
  permissions: ['users.view', 'users.create', 'users.edit', 'users.delete', 'settings.permissions']
};
const mockSystemRoles = [
  { id: 'guardia', label: 'Guardia', isSystem: true },
  { id: 'supervisor', label: 'Jefe de seguridad', isSystem: true },
  { id: 'monitoreo', label: 'Monitoreo', isSystem: true },
  { id: 'responsable', label: 'Responsable de empresa', isSystem: true },
  { id: 'admin', label: 'Sistemas', isSystem: true }
];

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: mockUsersActor,
    systemRoles: mockSystemRoles
  })
}));

const mockUsersToast = {
  showSuccess: jest.fn(),
  showError: jest.fn(),
  setError: jest.fn()
};

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => mockUsersToast
}));

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: jest.fn(async () => true) })
}));

const { apiFetch } = require('../../../services/api');

describe('Usuarios del sistema', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn(async () => {}) }
    });
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (path === '/admin/users' && options.method === 'POST') {
        return { message: 'Usuario creado', user: { id: 'nuevo', username: options.body.username } };
      }
      if (path === '/admin/users') {
        return {
          users: [{
            id: 'ana',
            username: 'ana',
            role: 'guardia',
            active: true,
            lastLoginAt: '2026-10-01T12:00:00.000Z',
            customPermissions: []
          }]
        };
      }
      if (path === '/requests/options') return { empresas: [{ id: 'e1', nombre: 'Acme' }] };
      return {};
    });
  });

  it('da de alta un usuario eligiendo la tarjeta Guardia', async () => {
    const runAction = jest.fn(async (_id, fn) => fn());
    render(<UsersAdminSection pendingAction={null} runAction={runAction} permissionKeys={[]} />);

    expect(await screen.findByRole('heading', { name: 'Usuarios del sistema' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(await screen.findByText(/Último ingreso/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desactivar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Eliminar ana' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo usuario' }));
    expect(screen.getByRole('heading', { name: '¿Qué hace esta persona en el sistema?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Guardia/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Ana Pérez' } });
    fireEvent.change(screen.getByLabelText('Usuario o mail'), { target: { value: 'ana.perez' } });
    fireEvent.change(screen.getByLabelText('Puesto o puertas', { selector: 'input, textarea, select' }), { target: { value: 'Portón principal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Crear usuario' }));

    await waitFor(() => {
      const call = apiFetch.mock.calls.find((item) => item[0] === '/admin/users' && item[1]?.method === 'POST');
      expect(call[1].body.role).toBe('guardia');
      expect(call[1].body.nombre).toBe('Ana Pérez');
      expect(call[1].body.puesto).toBe('Portón principal');
      expect(String(call[1].body.password).length).toBeGreaterThanOrEqual(8);
    });
  });
});
