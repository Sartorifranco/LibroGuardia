import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccessKiosk from './AccessKiosk';

jest.mock('./ContinuousScanner', () => ({ onScan }) => (
  <>
    <button type="button" onClick={() => onScan(` ${'mssv1.'}${'f6'.repeat(16)} `)}>scan-pass</button>
    <button type="button" onClick={() => onScan('30111222')}>scan-dni</button>
  </>
));
jest.mock('./ManualDoorButton', () => () => null);
jest.mock('../utils/kioskSounds', () => ({
  playKioskSound: jest.fn(),
  stopKioskSound: jest.fn(),
  unlockKioskAudio: jest.fn(() => Promise.resolve())
}));
jest.mock('../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../services/api');

const PASS = `MSSV1.${'F6'.repeat(16)}`;

function mockScan(response) {
  apiFetch.mockImplementation((path) => {
    if (path === '/access/kiosk-scan') return Promise.resolve(response);
    return Promise.resolve({});
  });
}

describe('AccessKiosk — QR de visita', () => {
  beforeEach(() => apiFetch.mockReset());

  it('envía el código MSSV1 como credencial y no lo muestra como DNI', async () => {
    mockScan({ authorized: true, reason: 'visita', name: 'Ana Pérez', idNumber: PASS });
    render(<AccessKiosk authToken="t" currentUser={{}} onExit={() => {}} doorId="p1" />);
    fireEvent.click(screen.getByText('scan-pass'));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/access/kiosk-scan',
      expect.objectContaining({ method: 'POST', body: { rawData: PASS, doorId: 'p1', readerId: 'default' } })
    ));
    expect(await screen.findByText('Ana Pérez')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(PASS))).not.toBeInTheDocument();
  });

  it('el DNI sigue funcionando', async () => {
    mockScan({ authorized: true, name: 'Ana Pérez', idNumber: '30111222' });
    render(<AccessKiosk authToken="t" currentUser={{}} onExit={() => {}} />);
    fireEvent.click(screen.getByText('scan-dni'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/access/kiosk-scan',
      expect.objectContaining({ body: expect.objectContaining({ rawData: '30111222' }) })
    ));
    expect(await screen.findByText('DNI 30111222')).toBeInTheDocument();
  });
});
