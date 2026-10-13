import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import QRCode from 'qrcode';
import VisitaInvitacionPage from './VisitaInvitacionPage';

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(() => Promise.resolve('data:image/png;base64,qr'))
}));

jest.mock('../../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../../services/api');

const PASS = `MSSV1.${'C3'.repeat(16)}`;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/invitacion/tok-1234567890abcdef']}>
      <Routes>
        <Route path="/invitacion/:token" element={<VisitaInvitacionPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('VisitaInvitacionPage', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    QRCode.toDataURL.mockReset();
    QRCode.toDataURL.mockResolvedValue('data:image/png;base64,qr');
  });

  it('muestra el QR con el código de pase y el DNI enmascarado', async () => {
    apiFetch.mockResolvedValue({
      invite: {
        id: 'v1',
        nombreVisitante: 'Ana Pérez',
        dniMasked: '***222',
        passCode: PASS,
        destinoNombre: 'Planta',
        fechaHoraEsperada: '2026-10-14T10:00:00.000-03:00'
      }
    });
    renderPage();
    expect(await screen.findByAltText('QR de acceso')).toBeInTheDocument();
    expect(QRCode.toDataURL.mock.calls[0][0]).toBe(PASS);
    expect(screen.getByText('DNI ***222')).toBeInTheDocument();
  });

  it.each([
    [{ duracion: 'horas', fechaHoraEsperada: '2026-10-14T09:00:00', inviteExpiresAt: '2026-10-14T13:00:00' }, 'Válido el 14/10 de 9:00 a 13:00'],
    [{ duracion: 'mes', fechaHoraEsperada: '2026-10-14T00:00:00', inviteExpiresAt: '2026-11-13T23:59:59' }, 'Válido del 14/10 al 13/11'],
    [{ duracion: 'un_ingreso', fechaHoraEsperada: '2026-10-14T10:00:00', inviteExpiresAt: '2026-10-14T23:59:59' }, /Sirve para un solo ingreso/]
  ])('muestra la validez según la duración (%#)', async (extra, texto) => {
    apiFetch.mockResolvedValue({
      invite: { id: 'v1', nombreVisitante: 'Ana', passCode: PASS, destinoNombre: 'Planta', ...extra }
    });
    renderPage();
    expect(await screen.findByText(texto)).toBeInTheDocument();
  });

  it('si la invitación venció o fue cancelada (410) lo explica simple', async () => {
    const err = new Error('Esta invitación ya venció.');
    err.status = 410;
    apiFetch.mockRejectedValue(err);
    renderPage();
    expect(await screen.findByText('Esta invitación ya no es válida')).toBeInTheDocument();
    expect(screen.getByText(/pedile una nueva a quien te invitó/)).toBeInTheDocument();
    await waitFor(() => expect(QRCode.toDataURL).not.toHaveBeenCalled());
    expect(screen.queryByAltText('QR de acceso')).not.toBeInTheDocument();
  });
});
