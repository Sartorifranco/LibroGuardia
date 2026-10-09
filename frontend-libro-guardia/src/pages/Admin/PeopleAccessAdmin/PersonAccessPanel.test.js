import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PersonAccessPanel from './PersonAccessPanel';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({
    showSuccess: jest.fn(),
    showError: jest.fn()
  })
}));

const mockConfirm = jest.fn(async () => true);

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: (...args) => mockConfirm(...args) })
}));

const { apiFetch } = require('../../../services/api');

const view = {
  id: 'ana',
  name: 'Ana',
  accessLevels: [],
  accessAll: false,
  summary: [
    'Grupo Administración: L–V 8 a 18 en Ingreso y Oficinas',
    'Citado hoy',
    'Puerta asignada directamente'
  ]
};

describe('PersonAccessPanel', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (path === '/admin/people/ana/access' && options.method === 'PUT') {
        return {
          message: 'Accesos actualizados.',
          ...view,
          accessLevels: options.body.accessLevels || view.accessLevels,
          accessAll: Object.prototype.hasOwnProperty.call(options.body, 'accessAll')
            ? options.body.accessAll
            : view.accessAll
        };
      }
      if (path === '/admin/people/ana/access') return view;
      if (path === '/admin/access-groups') {
        return {
          groups: [{ id: 'grp_admin', name: 'Administración', memberCount: 1 }]
        };
      }
      return {};
    });
  });

  it('muestra el resumen y guarda los grupos', async () => {
    render(<PersonAccessPanel personId="ana" authToken="token-test" />);
    expect(await screen.findByText(/Grupo Administración: L–V 8 a 18 en Ingreso y Oficinas/)).toBeInTheDocument();
    expect(screen.getByText('Citado hoy')).toBeInTheDocument();
    expect(screen.getByText('Puerta asignada directamente')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Administración' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar grupos' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/people/ana/access', expect.objectContaining({
        method: 'PUT',
        body: { accessLevels: ['grp_admin'] }
      }));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Guardar grupos' })).toBeEnabled();
    });
  });

  it('pide confirmación antes de dar acceso total', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    render(<PersonAccessPanel personId="ana" authToken="token-test" />);
    const sw = await screen.findByRole('switch', { name: /Acceso total/ });
    fireEvent.click(sw);
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(apiFetch).not.toHaveBeenCalledWith('/admin/people/ana/access', expect.objectContaining({ method: 'PUT' }));

    mockConfirm.mockResolvedValueOnce(true);
    fireEvent.click(sw);
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/people/ana/access', expect.objectContaining({
        method: 'PUT',
        body: { accessAll: true }
      }));
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /Acceso total/ })).toHaveAttribute('aria-checked', 'true');
    });
  });
});
