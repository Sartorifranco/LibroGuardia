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
            connectionStatus: 'offline'
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

    // El formulario de alta arriba sigue siendo "Nuevo lector", no "Editar".
    expect(screen.getByText('Nuevo lector')).toBeInTheDocument();
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

    expect(screen.getByText(/próximo heartbeat/i)).toBeInTheDocument();
  });
});
