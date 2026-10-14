import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EmpleadoVisitasPage from './EmpleadoVisitasPage';

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
const BASE_USER = { id: 'u1', nombre: 'Laura', role: 'empleado', permissions: ['visitas.create', 'visitas.view.own'] };
let mockCurrentUser = BASE_USER;

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'tok',
    currentUser: mockCurrentUser,
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

function resetMocks() {
  apiFetch.mockReset();
  mockShowSuccess.mockReset();
  mockShowError.mockReset();
  mockCurrentUser = BASE_USER;
}

async function fillAlta() {
  const nombre = await screen.findByLabelText('Nombre del visitante');
  await waitFor(() => expect(nombre).not.toBeDisabled());
  fireEvent.change(nombre, { target: { value: 'Juan Gómez' } });
  fireEvent.change(screen.getByLabelText('DNI'), { target: { value: '28999111' } });
  fireEvent.change(screen.getByLabelText('Destino'), { target: { value: 'd1' } });
}

function submitAlta() {
  fireEvent.submit(screen.getByRole('button', { name: 'Registrar visita' }).closest('form'));
}

const postBody = () => apiFetch.mock.calls.find(([p, o]) => p === '/empleado/visitas' && o?.method === 'POST')?.[1].body;

describe('EmpleadoVisitasPage — duración del pase', () => {
  beforeEach(resetMocks);

  it.each([
    ['Un solo ingreso', { 'Día': '2026-10-20', 'Hora de llegada': '09:00' }, {
      duracion: 'un_ingreso',
      fechaHoraEsperada: new Date('2026-10-20T09:00').toISOString(),
      validoHasta: null
    }],
    ['Por horas', { 'Día': '2026-10-20', 'Desde la hora': '09:00', 'Hasta la hora': '13:00' }, {
      duracion: 'horas',
      fechaHoraEsperada: new Date('2026-10-20T09:00').toISOString(),
      validoHasta: new Date('2026-10-20T13:00').toISOString()
    }],
    ['Todo el día', { 'Día': '2026-10-20' }, {
      duracion: 'dia',
      fechaHoraEsperada: new Date('2026-10-20T00:00').toISOString(),
      validoHasta: null
    }],
    ['Por mes', { 'Desde el día': '2026-10-14', 'Hasta el día': '2026-11-13' }, {
      duracion: 'mes',
      fechaHoraEsperada: new Date('2026-10-14T00:00').toISOString(),
      validoHasta: '2026-11-13'
    }]
  ])('"%s" manda duracion y validoHasta con los nombres del backend', async (opcion, campos, esperado) => {
    mockApi({
      'POST /empleado/visitas': () => Promise.resolve({ message: 'ok', visita: { id: 'v9', estado: 'pendiente_aprobacion' } })
    });
    renderPage();
    await fillAlta();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(opcion) }));
    expect(screen.getByRole('radio', { name: new RegExp(opcion) })).toHaveAttribute('aria-checked', 'true');
    Object.entries(campos).forEach(([label, value]) => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    });
    submitAlta();
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toEqual(expect.objectContaining({ ...esperado, destinoId: 'd1', nombreVisitante: 'Juan Gómez' }));
  });

  it('"Por mes" deja elegir el horario del sitio y lo manda como scheduleId', async () => {
    mockApi({
      'GET /empleado/horarios': () => Promise.resolve({
        horarios: [{ id: 'sch_oficina', nombre: 'Oficina', resumen: 'lun a vie 8:00 a 17:00' }]
      }),
      'POST /empleado/visitas': () => Promise.resolve({ message: 'ok', visita: { id: 'v9', estado: 'pendiente_aprobacion' } })
    });
    renderPage();
    await fillAlta();
    fireEvent.click(screen.getByRole('radio', { name: /Por mes/ }));
    fireEvent.change(screen.getByLabelText('Desde el día'), { target: { value: '2026-10-14' } });
    fireEvent.change(screen.getByLabelText('Hasta el día'), { target: { value: '2026-11-13' } });
    const horario = screen.getByLabelText('Horario en que puede entrar');
    await screen.findByRole('option', { name: 'Oficina (lun a vie 8:00 a 17:00)' });
    fireEvent.change(horario, { target: { value: 'sch_oficina' } });
    submitAlta();
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toEqual(expect.objectContaining({ duracion: 'mes', scheduleId: 'sch_oficina' }));
  });

  it('sin horarios cargados, "Por mes" vale a cualquier hora y lo explica', async () => {
    mockApi({
      'POST /empleado/visitas': () => Promise.resolve({ message: 'ok', visita: { id: 'v9', estado: 'pendiente_aprobacion' } })
    });
    renderPage();
    await fillAlta();
    fireEvent.click(screen.getByRole('radio', { name: /Por mes/ }));
    expect(screen.getByText(/Administración tiene que cargar los horarios/)).toBeInTheDocument();
    submitAlta();
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().scheduleId).toBeNull();
  });

  it('no deja pedir un pase por mes de más de 31 días', async () => {
    mockApi();
    renderPage();
    await fillAlta();
    fireEvent.click(screen.getByRole('radio', { name: /Por mes/ }));
    fireEvent.change(screen.getByLabelText('Desde el día'), { target: { value: '2026-10-14' } });
    fireEvent.change(screen.getByLabelText('Hasta el día'), { target: { value: '2026-11-14' } });
    submitAlta();
    expect(mockShowError).toHaveBeenCalledWith('El pase por mes puede durar como máximo 31 días.');
    expect(postBody()).toBeUndefined();
  });

  it('por horas exige que la hora de fin sea después de la de inicio', async () => {
    mockApi();
    renderPage();
    await fillAlta();
    fireEvent.click(screen.getByRole('radio', { name: /Por horas/ }));
    fireEvent.change(screen.getByLabelText('Desde la hora'), { target: { value: '13:00' } });
    fireEvent.change(screen.getByLabelText('Hasta la hora'), { target: { value: '09:00' } });
    submitAlta();
    expect(mockShowError).toHaveBeenCalledWith('La hora de fin tiene que ser después de la hora de inicio.');
    expect(postBody()).toBeUndefined();
  });

  it('muestra la duración y la validez en la lista', async () => {
    mockApi();
    apiFetch.mockImplementation((path, opts = {}) => {
      if (path === '/empleado/destinos') return Promise.resolve({ destinos: [{ id: 'd1', nombre: 'Planta' }] });
      if (path === '/empleado/visitas' && !opts.method) {
        return Promise.resolve({
          visitas: [
            visita,
            { ...visita, id: 'v2', nombreVisitante: 'Bruno', duracion: 'horas', fechaHoraEsperada: '2026-10-14T09:00:00', validoHasta: '2026-10-14T13:00:00' },
            { ...visita, id: 'v3', nombreVisitante: 'Carla', duracion: 'mes', fechaHoraEsperada: '2026-10-14T00:00:00', validoHasta: '2026-11-13T23:59:59' }
          ]
        });
      }
      return Promise.reject(new Error(`sin mock: ${path}`));
    });
    renderPage();
    expect(await screen.findByText(/^1 ingreso/)).toBeInTheDocument();
    expect(screen.getByText(/9:00 a 13:00$/)).toBeInTheDocument();
    expect(screen.getByText('Del 14/10 al 13/11')).toBeInTheDocument();
  });
});

describe('EmpleadoVisitasPage — mail y dominio', () => {
  beforeEach(resetMocks);

  it('si el mail no está confirmado muestra el aviso y reenvía (con límite de 2 minutos)', async () => {
    mockCurrentUser = { ...BASE_USER, email: 'laura@bacarsa.com.ar', emailVerified: false };
    let calls = 0;
    mockApi({
      'POST /auth/resend-verification': () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ message: 'Te mandamos un mail nuevo. Revisá tu correo (y la carpeta de spam).', sent: true });
        const err = new Error('Ya te mandamos un mail hace un momento. Esperá 2 minutos y probá de nuevo.');
        err.status = 429;
        return Promise.reject(err);
      }
    });
    renderPage();
    expect(await screen.findByText('Confirmá tu mail para poder invitar visitas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reenviar mail/ }));
    expect(await screen.findByText(/Te mandamos un mail nuevo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reenviar mail/ }));
    expect(await screen.findByText(/Esperá 2 minutos/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/auth/resend-verification', expect.objectContaining({ method: 'POST' }));
  });

  it('el 403 por mail sin confirmar al invitar muestra el aviso fijo', async () => {
    const err = new Error('Confirmá tu mail para poder invitar visitas. Revisá tu correo.');
    err.status = 403;
    err.data = { code: 'email_no_verificado', message: err.message };
    mockApi({ 'POST /empleado/visitas': () => Promise.reject(err) });
    renderPage();
    await fillAlta();
    submitAlta();
    expect(await screen.findByText('Confirmá tu mail para poder invitar visitas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reenviar mail/ })).toBeInTheDocument();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('el 403 por dominio muestra el mensaje del backend arriba del formulario', async () => {
    const err = new Error('No tenés permiso');
    err.status = 403;
    err.data = { code: 'dominio_no_permitido', message: 'Solo el personal con mail @bacarsa.com.ar puede invitar visitas.' };
    mockApi({ 'POST /empleado/visitas': () => Promise.reject(err) });
    renderPage();
    await fillAlta();
    submitAlta();
    expect(await screen.findByText('Solo el personal con mail @bacarsa.com.ar puede invitar visitas.')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/empleado/visitas', expect.objectContaining({ allowForbidden: true }));
    expect(mockShowError).not.toHaveBeenCalled();
  });
});

describe('EmpleadoVisitasPage — editar y cancelar', () => {
  beforeEach(resetMocks);

  it('cambia la duración al editar', async () => {
    mockApi({
      'PATCH /empleado/visitas/v1': (opts) => Promise.resolve({ visita: { ...visita, ...opts.body, estado: 'autorizada' } })
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar visita de Ana Pérez' }));
    const dialog = screen.getByRole('dialog', { name: 'Editar visita' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Todo el día/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/empleado/visitas/v1',
      expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ duracion: 'dia', validoHasta: null }) })
    ));
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
