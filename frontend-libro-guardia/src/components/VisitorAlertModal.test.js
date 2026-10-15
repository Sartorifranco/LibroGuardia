import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VisitorAlertModal, buildMismatchNovedad } from './VisitorAlertModal';
import apiFetch from '../services/api';

// Mock HubLiveContext
const mockSubscribe = jest.fn();
jest.mock('../context/HubLiveContext', () => ({
  useHubLive: () => ({
    subscribe: mockSubscribe,
  }),
}));

// Mock apiFetch
jest.mock('../services/api', () => jest.fn(() => Promise.resolve({ ok: true })));

// Mock Modal component
jest.mock('./admin-ui/Modal', () => ({
  Modal: ({ open, title, onClose, children, footer }) => {
    if (!open) return null;
    return (
      <div data-testid="mock-modal">
        <h2 data-testid="modal-title">{title}</h2>
        <div data-testid="modal-children">{children}</div>
        <div data-testid="modal-footer">{footer}</div>
        <button data-testid="modal-close-button" onClick={onClose}>Cerrar</button>
      </div>
    );
  },
}));

// Mock window.AudioContext to prevent sound playing during tests
beforeEach(() => {
  window.AudioContext = jest.fn().mockImplementation(() => ({
    createOscillator: jest.fn().mockImplementation(() => ({
      type: '',
      frequency: { setValueAtTime: jest.fn() },
      connect: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    })),
    createGain: jest.fn().mockImplementation(() => ({
      gain: { setValueAtTime: jest.fn() },
      connect: jest.fn(),
    })),
    currentTime: 0,
    destination: {},
  }));
  window.webkitAudioContext = window.AudioContext; // For broader browser compatibility mock
});

// Utility para disparar un evento desde el mock de HubLiveContext
let hubLiveListener = null;
beforeEach(() => {
  jest.clearAllMocks();
  apiFetch.mockImplementation(() => Promise.resolve({ ok: true }));
  // Resetear el listener antes de cada test
  mockSubscribe.mockImplementation((cb) => {
    hubLiveListener = cb;
    return () => { hubLiveListener = null; };
  });
});

const triggerVisitorEvent = (eventData) => {
  if (hubLiveListener) {
    act(() => {
      hubLiveListener({ type: 'visitor', data: eventData });
    });
  } else {
    console.warn('HubLiveContext listener not set.');
  }
};

describe('VisitorAlertModal', () => {
  it('(a) un evento visitor "visita" muestra "Pasó una visita", el nombre y la puerta; "Es la persona" lo cierra.', async () => {
    const alert = {
      id: 'visita-1',
      kind: 'visita',
      name: 'Juan Pérez',
      idNumber: '12345678',
      hostName: 'María Gómez',
      hostCompany: 'Tech Corp',
      destination: 'Oficina 301',
      doorId: 'd-1',
      doorName: 'Entrada Principal',
      side: 'in',
      at: '2026-10-14T10:30:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);

    expect(screen.getByTestId('mock-modal')).toBeInTheDocument();
    expect(screen.getByTestId('modal-title')).toHaveTextContent('Pasó una visita');
    expect(screen.getByText('Juan Pérez')).toBeInTheDocument();
    expect(screen.getByText('Entrada Principal · entrada')).toBeInTheDocument();
    expect(screen.getByText('Mirá a la persona y confirmá que es quien dice el cartel.')).toBeInTheDocument();
    expect(screen.getByText('Hora')).toBeInTheDocument();
    expect(screen.getByText('10:30')).toBeInTheDocument();


    fireEvent.click(screen.getByText('Es la persona'));

    await waitFor(() => {
      expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
    });
  });

  it('(b) "No coincide" llama onMismatch.', async () => {
    const onMismatch = jest.fn();
    const alert = {
      id: 'visita-2',
      kind: 'visita',
      name: 'Ana García',
      doorName: 'Salida de Emergencia',
      side: 'out',
      at: '2026-10-14T11:00:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" onMismatch={onMismatch} />);

    triggerVisitorEvent(alert);

    expect(screen.getByTestId('mock-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByText('No coincide'));

    await waitFor(() => {
      expect(onMismatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'visita-2' }));
      expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
    });
  });

  it('(c) "aprobacion" + "Abrir" llama apiFetch con /guard/approvals/apr-1 y body { approve: true }.', async () => {
    const alert = {
      id: 'apr-1',
      kind: 'aprobacion',
      approvalId: 'apr-1',
      name: 'Carlos Sánchez',
      doorName: 'Puerta Principal',
      side: 'in',
      at: '2026-10-14T12:00:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);

    expect(screen.getByTestId('mock-modal')).toBeInTheDocument();
    expect(screen.getByTestId('modal-title')).toHaveTextContent('Alguien pide entrar');
    expect(screen.getByText('Esta puerta necesita tu OK. Mirá a la persona antes de abrir.')).toBeInTheDocument();

    const openButton = screen.getByText('Abrir');
    fireEvent.click(openButton);

    expect(openButton).toBeDisabled(); // Check if buttons are disabled during API call

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/guard/approvals/apr-1', {
        method: 'POST',
        token: 'test-token',
        body: { approve: true },
      });
      expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
    });
  });

  it('(d) eventos de otro tipo ("access") no muestran nada.', async () => {
    render(<VisitorAlertModal authToken="test-token" />);

    act(() => {
      if (hubLiveListener) {
        hubLiveListener({ type: 'access', data: { id: 'acc-1', type: 'in' } });
      }
    });

    expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
  });

  it('(e) "No abrir" para aprobación llama apiFetch con { approve: false }', async () => {
    const alert = {
      id: 'apr-2',
      kind: 'aprobacion',
      approvalId: 'apr-2',
      name: 'Laura Fernandez',
      doorName: 'Puerta Trasera',
      side: 'out',
      at: '2026-10-14T13:00:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);

    const denyButton = screen.getByText('No abrir');
    fireEvent.click(denyButton);

    expect(denyButton).toBeDisabled();

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/guard/approvals/apr-2', {
        method: 'POST',
        token: 'test-token',
        body: { approve: false },
      });
      expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
    });
  });

  it('(f) Maneja errores al enviar aprobación y muestra mensaje.', async () => {
    apiFetch.mockImplementationOnce(() => Promise.reject(new Error('Problema de conexión'))); // Mock a rejection
    const alert = {
      id: 'apr-3',
      kind: 'aprobacion',
      approvalId: 'apr-3',
      name: 'Pedro Torres',
      doorName: 'Entrada Servicio',
      side: 'in',
      at: '2026-10-14T14:00:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);

    const openButton = screen.getByText('Abrir');
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Problema de conexión');
      expect(screen.getByTestId('mock-modal')).toBeInTheDocument(); // Modal debería seguir abierto
      expect(openButton).not.toBeDisabled(); // Los botones deberían volver a habilitarse
    });
  });

  it('(g) Pone en cola múltiples avisos y los muestra uno a uno.', async () => {
    const alert1 = { id: 'v-1', kind: 'visita', name: 'Visita 1', at: '2026-10-14T10:00:00-03:00' };
    const alert2 = { id: 'v-2', kind: 'externo', name: 'Externo 2', at: '2026-10-14T10:01:00-03:00' };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert1);
    expect(screen.getByText('Visita 1')).toBeInTheDocument();
    expect(screen.queryByText('Hay 1 aviso más')).not.toBeInTheDocument(); // Solo hay 1, no cuenta adicional

    triggerVisitorEvent(alert2); // Añadir el segundo aviso
    expect(screen.getByText('Hay 1 aviso más')).toBeInTheDocument(); // Ahora hay un contador
    expect(screen.queryByText('Externo 2')).not.toBeInTheDocument(); // El segundo aviso aún no es visible

    fireEvent.click(screen.getByText('Es la persona')); // Cerrar el primer aviso

    await waitFor(() => {
      expect(screen.queryByText('Visita 1')).not.toBeInTheDocument();
      expect(screen.getByText('Externo 2')).toBeInTheDocument(); // El segundo aviso es ahora visible
      expect(screen.getByTestId('modal-title')).toHaveTextContent('Pasó una persona externa');
      expect(screen.queryByText('Hay N avisos más')).not.toBeInTheDocument(); // Ya no hay más avisos en cola
    });
  });

  it('(h) onClose del Modal para aprobación solo cierra el cartel sin responder.', async () => {
    const alert = {
      id: 'apr-4',
      kind: 'aprobacion',
      approvalId: 'apr-4',
      name: 'Felipe Ruiz',
      doorName: 'Recepción',
      side: 'in',
      at: '2026-10-14T15:00:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);

    expect(screen.getByTestId('mock-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('modal-close-button')); // Clic en el botón "Cerrar" (la "X")

    await waitFor(() => {
      expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
      expect(apiFetch).not.toHaveBeenCalledWith('/guard/approvals/apr-4', expect.any(Object)); // No debería haber llamada a la API
    });
  });

  it('No agrega avisos duplicados por ID.', async () => {
    const alert = { id: 'unique-alert', kind: 'visita', name: 'Duplicado', at: '2026-10-14T16:00:00-03:00' };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);
    expect(screen.getByText('Duplicado')).toBeInTheDocument();
    expect(screen.queryByText('Hay 1 aviso más')).not.toBeInTheDocument();

    triggerVisitorEvent(alert); // Disparar el mismo aviso de nuevo
    expect(screen.queryByText('Hay 1 aviso más')).not.toBeInTheDocument(); // No debería haber más de un aviso en cola

    fireEvent.click(screen.getByText('Es la persona'));
    await waitFor(() => {
      expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
    });
  });

  it('Descarta los avisos más viejos si la cola supera los 10.', async () => {
    render(<VisitorAlertModal authToken="test-token" />);

    // Añadir 10 avisos
    for (let i = 0; i < 10; i++) {
      triggerVisitorEvent({ id: `alert-${i}`, kind: 'visita', name: `Alert ${i}`, at: `2026-10-14T10:${i < 10 ? '0' + i : i}:00-03:00` });
    }
    expect(screen.getByText('Alert 0')).toBeInTheDocument(); // Primer aviso mostrado
    expect(screen.getByText('Hay 9 avisos más')).toBeInTheDocument(); // 9 más en cola

    // Añadir el 11º aviso: se descarta el más viejo (Alert 0)
    triggerVisitorEvent({ id: 'alert-10', kind: 'visita', name: 'Alert 10', at: '2026-10-14T10:10:00-03:00' });
    expect(screen.queryByText('Alert 0')).not.toBeInTheDocument();
    expect(screen.getByText('Alert 1')).toBeInTheDocument();
    expect(screen.getByText('Hay 9 avisos más')).toBeInTheDocument();
  });

  it('Muestra "Sin nombre" si el nombre está vacío o es null', async () => {
    const alert = {
      id: 'no-name',
      kind: 'visita',
      name: null, // Nombre nulo
      doorName: 'Entrada',
      side: 'in',
      at: '2026-10-14T17:00:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);

    expect(screen.getByTestId('mock-modal')).toBeInTheDocument();
    expect(screen.getByText('Sin nombre')).toBeInTheDocument();
    expect(screen.getByText('Nombre', { selector: 'dt' })).toBeInTheDocument(); // Asegurar que el dt para Nombre esté presente
  });

  it('No muestra filas para datos vacíos o nulos (excepto nombre)', async () => {
    const alert = {
      id: 'partial-data',
      kind: 'visita',
      name: 'Persona con Datos Parciales',
      idNumber: null, // Vacío
      hostName: '', // Vacío
      destination: undefined, // Vacío
      doorId: 'd-2',
      doorName: 'Puerta Secundaria',
      side: 'out',
      at: '2026-10-14T18:00:00-03:00',
    };
    render(<VisitorAlertModal authToken="test-token" />);

    triggerVisitorEvent(alert);

    expect(screen.getByText('Persona con Datos Parciales')).toBeInTheDocument();
    expect(screen.queryByText('Documento', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.queryByText('Visita a', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.queryByText('Destino', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.getByText('Puerta Secundaria · salida')).toBeInTheDocument();
    expect(screen.getByText('18:00')).toBeInTheDocument();
  });
  it('modo nube: el evento de ventana mss:visitor muestra el cartel y no se repite con el del hub', () => {
    render(<VisitorAlertModal authToken="t" />);
    const data = { id: 'ctl:9', kind: 'visita', name: 'Por la Nube', doorName: 'Ingreso Principal', side: 'in', at: '2026-10-14T16:43:00-03:00' };
    act(() => { window.dispatchEvent(new CustomEvent('mss:visitor', { detail: data })); });
    expect(screen.getByText('Por la Nube')).toBeInTheDocument();
    triggerVisitorEvent(data);
    expect(screen.queryByText(/avisos? más/)).not.toBeInTheDocument();
  });
});

describe('buildMismatchNovedad', () => {
  it('arma el texto de la novedad con los datos de la visita', () => {
    const { time, description } = buildMismatchNovedad({
      name: 'Ana Pérez',
      idNumber: '30111222',
      hostName: 'Surly',
      hostCompany: 'Arcor',
      doorName: 'Ingreso Principal',
      at: '2026-10-14T18:40:00.000Z'
    });
    expect(time).toBe('15:40');
    expect(description).toBe(
      'La persona que pasó no coincide con el pase. Nombre: Ana Pérez, documento 30111222, '
      + 'visita a Surly (Arcor), puerta Ingreso Principal, hora 15:40.'
    );
  });

  it('sin datos devuelve vacío', () => {
    expect(buildMismatchNovedad(null)).toEqual({ time: '', description: '' });
  });
});
