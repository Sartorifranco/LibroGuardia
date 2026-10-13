import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';
import VisitaInviteQrModal, { buildShareMessage } from './VisitaInviteQrModal';

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(() => Promise.resolve('data:image/png;base64,qr'))
}));

jest.mock('../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../services/api');

const PASS = `MSSV1.${'B2'.repeat(16)}`;

const visita = {
  id: 'v1',
  nombreVisitante: 'Ana Pérez',
  dniVisitante: '30111222',
  destinoNombre: 'Planta',
  estado: 'autorizada',
  inviteToken: 'tok-1234567890abcdef',
  passCode: PASS,
  fechaHoraEsperada: '2026-10-14T10:00:00.000-03:00'
};

describe('VisitaInviteQrModal', () => {
  beforeEach(() => {
    QRCode.toDataURL.mockReset();
    QRCode.toDataURL.mockResolvedValue('data:image/png;base64,qr');
    apiFetch.mockReset();
  });

  it('el QR lleva solo el código de pase y en pantalla el DNI va enmascarado', async () => {
    render(<VisitaInviteQrModal visita={visita} authToken="t" onClose={() => {}} />);
    await waitFor(() => expect(QRCode.toDataURL).toHaveBeenCalled());
    expect(QRCode.toDataURL.mock.calls[0][0]).toBe(PASS);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(await screen.findByAltText('Código QR de invitación')).toBeInTheDocument();
    expect(screen.getByText(/\*\*\*222/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/30111222/);
  });

  it('si falta el código lo pide al servidor antes de armar el QR', async () => {
    apiFetch.mockResolvedValue({
      inviteToken: visita.inviteToken,
      visita: { ...visita }
    });
    render(
      <VisitaInviteQrModal visita={{ ...visita, passCode: undefined }} authToken="t" onClose={() => {}} />
    );
    await waitFor(() => expect(QRCode.toDataURL).toHaveBeenCalledWith(PASS, expect.any(Object)));
    expect(apiFetch).toHaveBeenCalledWith('/empleado/visitas/v1/ensure-invite', expect.objectContaining({ method: 'POST' }));
  });

  it('el mensaje para compartir no incluye el DNI', () => {
    const msg = buildShareMessage(visita, 'https://x/invitacion/tok', 'Válido desde…');
    expect(msg).toMatch(/https:\/\/x\/invitacion\/tok/);
    expect(msg).not.toMatch(/30111222|\d{7,8}/);
  });
});
