import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AccessModelAdminSection from './AccessModelAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: { role: 'admin', permissions: ['access.groups.manage', 'personas.puertas.asignar'] }
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

const schedules = {
  schedules: [
    { id: '24x7', name: 'Siempre', always: true, builtin: true },
    {
      id: 'sch_oficina',
      name: 'Oficina',
      intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
      toleranceBeforeMin: 0,
      toleranceAfterMin: 0,
      holidayBehavior: 'deny'
    }
  ]
};

const groups = {
  groups: [{
    id: 'grp_admin',
    name: 'Administración',
    scheduleId: 'sch_oficina',
    doors: ['p1', 'p2'],
    memberCount: 2
  }],
  doors: [
    { id: 'p1', name: 'Ingreso', zone: 'Planta' },
    { id: 'p2', name: 'Oficinas', zone: 'Planta' }
  ]
};

describe('AccessModelAdminSection', () => {
  beforeEach(() => {
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (String(path).includes('/national')) {
        return { dates: [{ date: '2026-01-01', name: 'Año Nuevo' }] };
      }
      if (String(path).startsWith('/admin/holidays/')) {
        return { dates: [] };
      }
      if (path === '/admin/schedules') return schedules;
      if (path === '/admin/access-groups') return groups;
      if (String(path).startsWith('/admin/people?q=')) {
        return { people: [{ id: 'ana', name: 'Ana', idNumber: '30111222' }] };
      }
      if (path === '/admin/access/simulate' && options.method === 'POST') {
        return {
          decision: 'grant',
          allows: true,
          headline: 'Sí, puede pasar.',
          message: 'Entra por el grupo Administración.',
          warnings: []
        };
      }
      return {};
    });
  });

  it('muestra cuántas personas tiene el grupo', async () => {
    render(<AccessModelAdminSection />);
    expect(await screen.findByText(/2 personas/)).toBeInTheDocument();
    expect(screen.getByText('Administración')).toBeInTheDocument();
  });

  it('el horario Siempre no se edita y se pueden agregar franjas', async () => {
    render(<AccessModelAdminSection />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Horarios' }));
    expect(await screen.findByText(/No se puede modificar/)).toBeInTheDocument();
    expect(screen.getByText('Siempre')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Editar' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo horario' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agregar franja' }));
    expect(screen.getAllByLabelText('Desde')).toHaveLength(2);
    const lunes = screen.getAllByRole('button', { name: 'Lunes' });
    expect(lunes).toHaveLength(2);
    expect(lunes[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('carga feriados nacionales', async () => {
    render(<AccessModelAdminSection />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Feriados' }));
    expect(await screen.findByText(/Este año no tiene feriados/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar feriados nacionales' }));
    expect(await screen.findByText(/1 ene · Año Nuevo/)).toBeInTheDocument();
  });

  it('consulta si una persona puede pasar', async () => {
    render(<AccessModelAdminSection />);
    fireEvent.click(await screen.findByRole('tab', { name: '¿Puede pasar?' }));
    fireEvent.change(await screen.findByLabelText('Buscar persona'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
    fireEvent.change(screen.getByLabelText('Fecha y hora'), { target: { value: '2026-10-08T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }));
    expect(await screen.findByText('Sí, puede pasar.')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/admin/access/simulate', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ personId: 'ana', doorId: 'p1', at: '2026-10-08T10:00' })
    }));
  });
});
