import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import EstacionesAdminSection from './EstacionesAdminSection';

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

describe('EstacionesAdminSection', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === '/admin/estaciones') {
        return {
          estaciones: [{
            id: 'est-1',
            nombre: 'Mini PC ingreso',
            direccionRedLocal: '192.168.1.50',
            puertoServidorLocal: 8787,
            secretoLocal: 'sec',
            activa: true,
            lectoresCount: 0,
            lectorIds: []
          }]
        };
      }
      if (path === '/admin/lectores') {
        return {
          lectores: [{
            id: 'lec-1',
            nombre: 'Ingreso P1',
            doorId: 'puerta-p1',
            readerId: 'INGRESO_P1',
            estacionId: ''
          }]
        };
      }
      if (path === '/admin/estaciones/est-1/config') {
        return {
          config: {
            apiBaseUrl: 'https://mss-guard.web.app/api',
            localServerPort: 8787,
            localServerSecret: 'sec',
            readers: []
          }
        };
      }
      if (path === '/admin/estaciones/est-1/lectores' && opts.method === 'PUT') {
        return { lectorIds: opts.body?.lectorIds || [], lectores: [] };
      }
      return {};
    });
  });

  it('lista estaciones y descarga config unificada', async () => {
    render(
      <EstacionesAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Mini PC ingreso')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Descargar config de Mini PC ingreso/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/estaciones/est-1/config',
        expect.objectContaining({ token: 'token-test' })
      );
    });
  });

  it('abre modal de asignación de lectores', async () => {
    render(
      <EstacionesAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Mini PC ingreso')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Asignar lectores a Mini PC ingreso/i }));

    await waitFor(() => {
      expect(screen.getByText(/Asignar lectores/i)).toBeInTheDocument();
      expect(screen.getByText(/Ingreso P1/)).toBeInTheDocument();
    });
  });

  it('abre popup de nueva estación bajo demanda', async () => {
    render(
      <EstacionesAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Mini PC ingreso')).toBeInTheDocument();
    });

    expect(screen.queryByRole('dialog', { name: /Nueva estación/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Nueva estación/i }));
    expect(screen.getByRole('dialog', { name: /Nueva estación/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Crear estación/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancelar/i })).toBeInTheDocument();
  });

  it('abre popup de editar estación', async () => {
    render(
      <EstacionesAdminSection
        pendingAction={null}
        runAction={async (_id, fn) => fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Mini PC ingreso')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Editar Mini PC ingreso/i }));
    expect(screen.getByRole('dialog', { name: /Editar estación/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Mini PC ingreso')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Guardar cambios/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancelar/i })).toBeInTheDocument();
  });
});
