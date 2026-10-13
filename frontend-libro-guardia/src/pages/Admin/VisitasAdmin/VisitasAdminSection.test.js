import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import VisitasAdminSection from './VisitasAdminSection';

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: { id: 'sup', role: 'supervisor', permissions: ['visitas.approve'] }
  })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({ showSuccess: mockShowSuccess, showError: mockShowError })
}));

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../../../services/api');

const pendiente = {
  id: 'v1',
  nombreVisitante: 'Técnico Ascensores',
  dniVisitante: '30111222',
  destinoNombre: 'Planta',
  estado: 'pendiente_aprobacion',
  duracion: 'mes',
  fechaHoraEsperada: '2026-10-14T00:00:00',
  validoHasta: { _seconds: Math.floor(new Date('2026-11-13T23:59:59').getTime() / 1000), _nanoseconds: 0 }
};

function mockApi(onPut) {
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/admin/visitas/pending') return Promise.resolve({ visitas: [pendiente] });
    if (path === '/admin/visitas/settings' && !opts.method) {
      return Promise.resolve({ settings: { dominiosAnfitrion: ['bacarsa.com.ar'] } });
    }
    if (path === '/admin/visitas/settings' && opts.method === 'PUT') return onPut(opts);
    return Promise.reject(new Error(`sin mock: ${path}`));
  });
}

describe('VisitasAdminSection', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    mockShowSuccess.mockReset();
    mockShowError.mockReset();
  });

  it('muestra duración y validez de cada visita pendiente', async () => {
    mockApi();
    render(<VisitasAdminSection />);
    expect(await screen.findByText('Técnico Ascensores')).toBeInTheDocument();
    expect(screen.getByText('Por mes')).toBeInTheDocument();
    expect(screen.getByText(/Del 14\/10 al 13\/11/)).toBeInTheDocument();
  });

  it('edita los dominios permitidos para invitar', async () => {
    const onPut = jest.fn((opts) => Promise.resolve({
      message: 'Configuración de visitas guardada',
      settings: { dominiosAnfitrion: opts.body.dominiosAnfitrion }
    }));
    mockApi(onPut);
    render(<VisitasAdminSection />);
    expect(await screen.findByText('@bacarsa.com.ar')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cambiar dominios/ }));
    const dialog = screen.getByRole('dialog', { name: 'Configuración de visitas' });
    const field = within(dialog).getByLabelText('Dominios permitidos para invitar');
    expect(field).toHaveValue('bacarsa.com.ar');

    fireEvent.change(field, { target: { value: 'bacarsa.com.ar, mal dominio' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no parece un dominio');
    expect(onPut).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: 'bacarsa.com.ar, @Otra.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(onPut).toHaveBeenCalled());
    expect(onPut.mock.calls[0][0].body).toEqual({ dominiosAnfitrion: ['bacarsa.com.ar', 'otra.com'] });
    expect(await screen.findByText('@bacarsa.com.ar, @otra.com')).toBeInTheDocument();
    expect(mockShowSuccess).toHaveBeenCalledWith('Configuración de visitas guardada');
  });
});
