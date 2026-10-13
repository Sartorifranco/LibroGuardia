import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PeopleAccessAdminSection from './PeopleAccessAdminSection';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockPeopleUser = {
  role: 'admin',
  permissions: ['access.doors.manage', 'personas.puertas.asignar']
};
const mockPeopleToast = { showSuccess: jest.fn(), showError: jest.fn() };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: mockPeopleUser
  })
}));

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => mockPeopleToast
}));

jest.mock('../../../context/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: jest.fn(async () => true) })
}));

const { apiFetch } = require('../../../services/api');

describe('Personas', () => {
  beforeEach(() => {
    apiFetch.mockImplementation(async (path) => {
      if (path.startsWith('/admin/people/ana/passages')) {
        return {
          passages: [{ id: 'p1', whenLabel: '01/10 09:00', movement: 'ingreso', place: 'Portón' }]
        };
      }
      if (path.startsWith('/admin/people/ana/access')) {
        return { id: 'ana', name: 'Ana Pérez', accessLevels: [], accessAll: false, summary: ['Grupo Administración'] };
      }
      if (path === '/admin/access-groups') return { groups: [] };
      if (path.startsWith('/admin/people')) {
        return {
          people: [{
            id: 'ana',
            name: 'Ana Pérez',
            idNumber: '30111222',
            legajo: '10',
            active: true,
            allowedDoorIds: [],
            accessCard: 'AB-1',
            biometricExternalId: 'bio-1'
          }],
          version: 1
        };
      }
      if (path === '/admin/doors-config') return { config: { doors: [] } };
      return {};
    });
  });

  it('abre la ficha con pestañas de datos, credenciales, accesos e historial', async () => {
    render(<PeopleAccessAdminSection />);
    expect(await screen.findByRole('heading', { name: 'Personas' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByLabelText('Buscar persona')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /Ana Pérez/ }));
    expect(screen.getByRole('tab', { name: 'Datos' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Credenciales' }));
    expect(screen.getByLabelText('DNI')).toHaveValue('30111222');
    expect(screen.getByText('Huella BioStar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dar de baja la huella' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Accesos' }));
    expect(await screen.findByText(/Grupo Administración/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Historial de pasos' }));
    expect(await screen.findByText(/Portón/)).toBeInTheDocument();
  });
});
