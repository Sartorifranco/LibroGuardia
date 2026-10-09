import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmProvider } from '../../context/ConfirmContext';
import AutorizacionesPage from './AutorizacionesPage';

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: {
      id: 'responsable',
      role: 'responsable',
      permissions: ['autorizaciones.aprobar', 'autorizaciones.solicitar']
    }
  })
}));

jest.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError
  })
}));

jest.mock('../../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../../services/api');

const pending = {
  id: 'req-1',
  tipo: 'visita',
  estado: 'pendiente',
  persona: { name: 'Ana Pérez', dni: '30111222' },
  empresaNombre: 'Acme',
  destinoNombre: 'Planta',
  puertas: ['p1'],
  desde: '2026-10-10T12:00:00.000Z',
  hasta: '2026-10-10T20:00:00.000Z',
  solicitadoPorNombre: 'Guardia',
  motivo: 'Visita de obra',
  puedeDecidir: true,
  puedeCancelar: false
};

function renderPage() {
  return render(
    <ConfirmProvider>
      <AutorizacionesPage />
    </ConfirmProvider>
  );
}

describe('AutorizacionesPage', () => {
  beforeEach(() => {
    mockShowSuccess.mockReset();
    mockShowError.mockReset();
    apiFetch.mockImplementation((path) => {
      if (String(path).startsWith('/requests/options')) {
        return Promise.resolve({
          empresas: [{ id: 'acme', nombre: 'Acme' }],
          destinos: [{ id: 'planta', nombre: 'Planta', doorIds: ['p1'] }]
        });
      }
      if (String(path).startsWith('/requests?')) {
        return Promise.resolve({ requests: [pending], pendingCount: 1, limit: 50 });
      }
      return Promise.resolve({ message: 'ok', request: { ...pending, estado: 'aprobada' } });
    });
  });

  test('muestra la pendiente con contador y aprueba', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: /Pendientes \(1\)/i })).toBeInTheDocument();
    expect(screen.getByText('Ana Pérez')).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Aprobar/i }));
    const dialog = await screen.findByRole('dialog', { name: /Aprobar ingreso/i });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Aprobar$/i }).at(-1));
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/requests/req-1/approve', expect.objectContaining({ method: 'POST' }));
    });
  });

  test('rechazar pide una nota', async () => {
    renderPage();
    await screen.findByText('Ana Pérez');
    fireEvent.click(screen.getByRole('button', { name: /^Rechazar$/i }));
    const note = screen.getByLabelText(/Por qué la rechazás/i);
    expect(screen.getByRole('button', { name: /Confirmar rechazo/i })).toBeDisabled();
    fireEvent.change(note, { target: { value: 'No corresponde' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar rechazo/i }));
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/requests/req-1/reject', expect.objectContaining({
        method: 'POST',
        body: { nota: 'No corresponde' }
      }));
    });
  });

  test('estado vacío', async () => {
    apiFetch.mockImplementation((path) => {
      if (String(path).startsWith('/requests/options')) return Promise.resolve({ empresas: [], destinos: [] });
      return Promise.resolve({ requests: [], pendingCount: 0, limit: 50 });
    });
    renderPage();
    expect(await screen.findByText(/No hay solicitudes pendientes/i)).toBeInTheDocument();
  });
});
