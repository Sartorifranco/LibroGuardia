import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AccessGpsAdminSection from './AccessGpsAdminSection';
import { kmhToKnots, knotsToKmh } from '../../../utils/speedUnits';

jest.mock('../../../services/api', () => ({
  apiFetch: jest.fn()
}));

const mockGpsUser = { role: 'admin', permissions: ['access.control'] };

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: mockGpsUser
  })
}));

const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();

jest.mock('../../../context/ToastContext', () => ({
  useToast: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError
  })
}));

jest.mock('../../../components/FleetGpsLiveMap', () => {
  const ReactLib = require('react');
  const MockMap = ReactLib.forwardRef(function MockMap({ onSnapshot }, ref) {
    ReactLib.useImperativeHandle(ref, () => ({ startDraw() {} }));
    ReactLib.useEffect(() => {
      onSnapshot?.({ vehicleCount: 12, vehicles: [] });
    }, [onSnapshot]);
    return <div>Mapa de vehículos</div>;
  });
  return { __esModule: true, default: MockMap };
});

jest.mock('../../../components/FleetGpsVehicleTable', () => ({
  __esModule: true,
  default: () => <div>Tabla de vehículos</div>,
  formatFleetTime: () => 'ahora'
}));

const { apiFetch } = require('../../../services/api');

describe('GPS de vehículos', () => {
  beforeEach(() => {
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (path === '/admin/fleet-gps' && options.method === 'PUT') {
        return { config: { ...(options.body || {}), hasApiKey: true, geofenceMode: 'polygon' } };
      }
      if (path === '/admin/fleet-gps') {
        return {
          config: {
            enabled: true,
            hasApiKey: true,
            minSpeedKnots: kmhToKnots(5),
            approachRadiusMeters: 800,
            autoRegisterMovements: true,
            geofenceMode: 'polygon',
            lastError: null
          }
        };
      }
      if (String(path).startsWith('/admin/fleet-gps/live')) {
        return { vehicleCount: 12, vehicles: [] };
      }
      return {};
    });
  });

  it('convierte kilómetros por hora a nudos y de vuelta', () => {
    const knots = kmhToKnots(5);
    expect(knots).toBeGreaterThan(2);
    expect(knots).toBeLessThan(3);
    expect(knotsToKmh(knots)).toBeCloseTo(5, 0);
    expect(knotsToKmh(1)).not.toBe(1);
  });

  it('muestra el mapa, la conexión y las reglas en km/h', async () => {
    const runAction = jest.fn(async (_id, fn) => fn());
    render(<AccessGpsAdminSection pendingAction={null} runAction={runAction} />);

    expect(await screen.findByRole('heading', { name: 'GPS de vehículos' })).toBeInTheDocument();
    expect(screen.getByText(/Para qué sirve:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dibujá el portón' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dibujá la planta' })).toBeInTheDocument();
    expect(await screen.findByText(/Conectado: 12 vehículos visibles/)).toBeInTheDocument();
    expect(screen.getByText(/km\/h/)).toBeInTheDocument();
    expect(screen.queryByText(/nudos/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/costo/i)).not.toBeInTheDocument();

    const speed = screen.getByLabelText('Velocidad mínima en kilómetros por hora');
    fireEvent.change(speed, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => {
      const saveCall = apiFetch.mock.calls.find((call) => call[0] === '/admin/fleet-gps' && call[1]?.method === 'PUT');
      expect(saveCall[1].body.minSpeedKnots).toBeCloseTo(kmhToKnots(10), 2);
    });
  });
});
