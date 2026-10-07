import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OfflineQueueProvider, useOfflineQueue } from './OfflineQueueContext';
import { apiFetch } from '../services/api';
import { checkBackendConnectivity } from '../utils/connectivity';
import * as offlineQueue from '../utils/offlineQueue';

jest.mock('../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('../utils/connectivity', () => ({
  checkBackendConnectivity: jest.fn(async () => ({ online: true }))
}));

jest.mock('./AuthContext', () => ({
  useAuth: () => ({
    authToken: 'token-test',
    currentUser: { username: 'guardia' }
  })
}));

jest.mock('./ToastContext', () => ({
  useToast: () => ({
    showSuccess: jest.fn(),
    showError: jest.fn()
  })
}));

jest.mock('../utils/offlineQueue', () => ({
  count: jest.fn(),
  listPending: jest.fn(),
  listRejected: jest.fn(),
  enqueue: jest.fn(),
  remove: jest.fn(),
  markRejected: jest.fn(),
  markPending: jest.fn()
}));

function FlushButton() {
  const { flushQueue } = useOfflineQueue();
  return (
    <button type="button" onClick={() => flushQueue()}>
      Enviar pendientes
    </button>
  );
}

describe('OfflineQueueProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkBackendConnectivity.mockResolvedValue({ online: true });
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true
    });
    offlineQueue.count.mockResolvedValue(0);
    offlineQueue.listRejected.mockResolvedValue([]);
    offlineQueue.remove.mockResolvedValue(true);
    offlineQueue.markRejected.mockResolvedValue({ status: 'rejected' });
    offlineQueue.listPending.mockResolvedValue([
      { id: 1, type: 'entry', payload: { type: 'personal', name: 'Juan Pérez' } },
      { id: 2, type: 'entry', payload: { type: 'novedad', description: 'Corte de luz' } }
    ]);
    const rejected = Object.assign(new Error('DNI duplicado'), { status: 409 });
    apiFetch
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce({ id: 'ok' });
  });

  test('un ítem rechazado por el servidor no se borra y no frena al resto', async () => {
    render(
      <OfflineQueueProvider>
        <FlushButton />
      </OfflineQueueProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enviar pendientes' }));

    await waitFor(() => {
      expect(offlineQueue.markRejected).toHaveBeenCalledWith(1, 'DNI duplicado');
    });
    expect(offlineQueue.remove).not.toHaveBeenCalledWith(1);
    expect(offlineQueue.remove).toHaveBeenCalledWith(2);
  });
});
