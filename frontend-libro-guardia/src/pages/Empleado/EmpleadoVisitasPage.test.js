import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EmpleadoVisitasPage from './EmpleadoVisitasPage';

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: { id: 'u1', nombre: 'Laura', role: 'empleado', permissions: ['visitas.create', 'visitas.view.own'] },
    logout: jest.fn()
  })
}));

jest.mock('../../context/ToastContext', () => ({
  useToast: () => ({
    error: null,
    successMessage: null,
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    setError: jest.fn(),
    setSuccessMessage: jest.fn()
  })
}));

jest.mock('../../components/ConnectivityChrome', () => () => null);
jest.mock('../../components/ToastStack', () => () => null);
jest.mock('../../components/PersonPhotoField', () => () => null);
jest.mock('../../components/VisitaInviteQrModal', () => ({ visita }) => (
  <div data-testid="qr-modal">{visita?.passCode}</div>
));

jest.mock('../../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../../services/api');

const visita = {
  id: 'v1',
  nombreVisitante: 'Ana Pérez',
  dniVisitante: '30111222',
  destinoId: 'd1',
  destinoNombre: 'Planta',
  estado: 'autorizada',
  motivo: 'Reunión',
  passCode: `MSSV1.${'D4'.repeat(16)}`,
  fechaHoraEsperada: '2026-10-14T10:00:00.000-03:00'
};

function mockApi(overrides = {}) {
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/empleado/destinos') {
      return Promise.resolve({ destinos: [{ id: 'd1', nombre: 'Planta' }, { id: 'd2', nombre: 'Oficinas' }] });
    }
    if (path === '/empleado/visitas' && !opts.method) return Promise.resolve({ visitas: [visita] });
    const handler = overrides[`${opts.method || 'GET'} ${path}`];
    if (handler) return handler(opts);
    return Promise.reject(new Error(`sin mock: ${path}`));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <EmpleadoVisitasPage />
    </MemoryRouter>
  );
}

describe('EmpleadoVisitasPage — editar y cancelar', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    mockShowSuccess.mockReset();
    mockShowError.mockReset();
  });

  it('cancela la visita después de confirmar y avisa que el QR deja de servir', async () => {
    mockApi({
      'POST /empleado/visitas/v1/cancel': () => Promise.resolve({
        message: 'Visita cancelada. El pase ya no sirve para entrar.',
        visita: { ...visita, estado: 'cancelada' }
      })
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar visita de Ana Pérez' }));

    const dialog = screen.getByRole('dialog', { name: '¿Cancelar esta visita?' });
    expect(within(dialog).getByText(/deja de servir/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, cancelar visita' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/empleado/visitas/v1/cancel',
      expect.objectContaining({ method: 'POST', token: 'tok' })
    ));
    await waitFor(() => expect(mockShowSuccess).toHaveBeenCalledWith(expect.stringMatching(/ya no sirve/)));
    expect(await screen.findByText('Cancelada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar visita de Ana Pérez' })).not.toBeInTheDocument();
  });

  it('edita la visita, avisa que hay invitación nueva y ofrece compartirla', async () => {
    const newPass = `MSSV1.${'E5'.repeat(16)}`;
    mockApi({
      'PATCH /empleado/visitas/v1': (opts) => Promise.resolve({
        message: 'Visita modificada.',
        visita: { ...visita, ...opts.body, destinoNombre: 'Oficinas', passCode: newPass }
      })
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar visita de Ana Pérez' }));

    const dialog = screen.getByRole('dialog', { name: 'Editar visita' });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'd2' } });
    fireEvent.change(within(dialog).getByLabelText('Motivo'), { target: { value: 'Auditoría' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/empleado/visitas/v1',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({ destinoId: 'd2', motivo: 'Auditoría', fechaHoraEsperada: expect.any(String) })
      })
    ));

    const notice = await screen.findByRole('dialog', { name: 'Se generó una invitación nueva' });
    fireEvent.click(within(notice).getByRole('button', { name: /Compartir \/ QR/ }));
    expect(await screen.findByTestId('qr-modal')).toHaveTextContent(newPass);
  });

  it('no guarda la edición sin destino', async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar visita de Ana Pérez' }));
    const dialog = screen.getByRole('dialog', { name: 'Editar visita' });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: '' } });
    fireEvent.submit(dialog.querySelector('form'));
    expect(await within(dialog).findByText('Elegí un destino.')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith('/empleado/visitas/v1', expect.anything());
  });
});
