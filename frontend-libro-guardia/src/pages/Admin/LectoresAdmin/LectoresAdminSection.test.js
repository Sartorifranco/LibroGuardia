import React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import LectoresAdminSection from './LectoresAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: { role: 'admin', permissions: ['lectores.manage'] }
  })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({
    showSuccess: jest.fn(),
    showError: jest.fn()
  })
}));

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({
    confirm: jest.fn(async () => true)
  })
}));

const { apiFetch } = require('../../../services/api');

describe('LectoresAdminSection — modal de edición', () => {
  beforeEach(() => {
    apiFetch.mockImplementation(async (path) => {
      if (path === '/admin/lectores') {
        return {
          lectores: [{
            id: 'lec-1',
            nombre: 'Ingreso Puerta 1',
            doorId: 'puerta-p1',
            readerId: 'INGRESO_P1',
            direction: 'ingreso',
            usuarioSistemaId: 'kiosk.puerta-p1.ingreso-p1',
            ultimaConexion: null,
            connectionStatus: 'offline',
            offlineCache: true,
            offlineCacheMaxAgeHours: 24,
            allowlistGeneratedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            allowlistEntryCount: 17
          }]
        };
      }
      if (path === '/admin/doors-config') {
        return {
          config: {
            doors: [{
              id: 'puerta-p1',
              name: 'Puerta 1',
              readers: [
                { id: 'INGRESO_P1', direction: 'ingreso' },
                { id: 'EGRESO_P1', direction: 'egreso' }
              ]
            }]
          }
        };
      }
      if (path === '/admin/lectores/lec-1/force-resync') {
        return {
          message: 'Resincronización pedida',
          lector: { id: 'lec-1', forceResync: true }
        };
      }
      if (path === '/admin/lectores/lec-1/pairing-code') {
        return {
          code: '482915',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          expiresInSeconds: 600,
          lectorId: 'lec-1',
          lectorNombre: 'Ingreso Puerta 1',
          doorId: 'puerta-p1',
          readerId: 'INGRESO_P1'
        };
      }
      if (path === '/admin/lectores/lec-1/clear-login-failures') {
        return {
          message: 'Se destrabaron los intentos de login de “kiosk.puerta-p1.ingreso-p1”.',
          username: 'kiosk.puerta-p1.ingreso-p1'
        };
      }
      return {};
    });
  });

  it('al hacer click en el lápiz abre modal centrado con datos precargados', async () => {
    render(
      <LectoresAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Ingreso Puerta 1')).toBeInTheDocument();
    });

    expect(screen.queryByRole('dialog', { name: /editar lector/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Editar'));

    const dialog = await screen.findByRole('dialog', { name: /editar lector/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass('admin-modal-backdrop');

    expect(within(dialog).getByDisplayValue('Ingreso Puerta 1')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('Puerta 1')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('INGRESO_P1 (ingreso)')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('Ingreso')).toBeInTheDocument();
    const allowlistBox = within(dialog).getByRole('status');
    expect(allowlistBox).toHaveTextContent(/lista de autorizados en la mini pc/i);
    expect(allowlistBox).toHaveTextContent(/17 autorizados/i);
    expect(within(dialog).getByRole('button', { name: /sincronizar ahora/i })).toBeInTheDocument();

    // El formulario de alta arriba sigue siendo "Nuevo lector", no "Editar".
    expect(screen.getByText('Nuevo lector')).toBeInTheDocument();
  });

  it('en la tabla muestra la columna de lista offline', async () => {
    render(
      <LectoresAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Ingreso Puerta 1')).toBeInTheDocument();
    });

    expect(screen.getByText('Lista offline')).toBeInTheDocument();
    expect(screen.getAllByText(/17 autorizados/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/offline activo/i)).toBeInTheDocument();
  });

  it('al hacer click en Sincronizar ahora pide force-resync', async () => {
    render(
      <LectoresAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Ingreso Puerta 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/sincronizar ahora/i));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/lectores/lec-1/force-resync',
        expect.objectContaining({ method: 'POST', token: 'token-test' })
      );
    });

    expect(screen.getByText(/unos segundos/i)).toBeInTheDocument();
  });

  it('genera código de instalación y lo muestra grande', async () => {
    render(
      <LectoresAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Ingreso Puerta 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Generar código de instalación'));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/lectores/lec-1/pairing-code',
        expect.objectContaining({ method: 'POST', token: 'token-test' })
      );
    });

    const dialog = await screen.findByRole('dialog', { name: /código de instalación/i });
    expect(within(dialog).getByLabelText(/código 482915/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/expira en 10 minutos/i)).toBeInTheDocument();
  });

  it('destrabar login llama al endpoint y confirma', async () => {
    render(
      <LectoresAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Ingreso Puerta 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Destrabar intentos de login'));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/lectores/lec-1/clear-login-failures',
        expect.objectContaining({ method: 'POST', token: 'token-test' })
      );
    });
  });
});
