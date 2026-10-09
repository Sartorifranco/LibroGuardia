import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import NotificationsAdminSection from './NotificationsAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: { role: 'admin', permissions: ['notifications.config'] }
  })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({
    showSuccess: jest.fn(),
    showError: jest.fn()
  })
}));

const { apiFetch } = require('../../../services/api');

const config = {
  enabled: true,
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    from: '',
    hasPassword: false
  },
  events: {
    repeated_denials: { enabled: true, recipients: [], threshold: 3, windowMinutes: 10 },
    edge_alarm: { enabled: true, recipients: ['ana@empresa.com'] }
  }
};

describe('Avisos por mail', () => {
  beforeEach(() => {
    apiFetch.mockImplementation(async (path) => {
      if (path === '/admin/notifications-config') return { config };
      if (path === '/admin/users') {
        return { users: [{ username: 'ana@empresa.com', nombre: 'Ana', email: 'ana@empresa.com' }] };
      }
      if (path === '/admin/notifications-config/test') return { message: 'Prueba enviada' };
      return {};
    });
  });

  it('explica para qué sirve y lista los avisos en lenguaje simple', async () => {
    render(<NotificationsAdminSection pendingAction={null} runAction={async (_id, fn) => fn()} />);
    expect(await screen.findByRole('heading', { name: 'Avisos por mail' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByText('Cómo se usa')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '¿Quién recibe qué aviso?' })).toBeInTheDocument();
    expect(screen.getAllByText('Puerta forzada').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Abierta demasiado tiempo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Coacción').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Equipo sin conexión').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Avisar si alguien es rechazado/).length).toBeGreaterThan(0);
  });

  it('el asistente de Gmail completa el servidor de correo', async () => {
    render(<NotificationsAdminSection pendingAction={null} runAction={async (_id, fn) => fn()} />);
    await screen.findByRole('heading', { name: 'Avisos por mail' });
    fireEvent.click(screen.getByRole('button', { name: 'Opciones avanzadas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    expect(screen.getByLabelText('Servidor SMTP')).toHaveValue('smtp.gmail.com');
    expect(screen.getByLabelText('Puerto')).toHaveValue(587);
  });
});
