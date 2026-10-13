import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EmpleadoVerificarPage from './EmpleadoVerificarPage';

jest.mock('../../services/api', () => ({
  apiFetch: jest.fn()
}));

const { apiFetch } = require('../../services/api');

const TOKEN = 'a'.repeat(64);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/empleado/verificar/${TOKEN}`]}>
      <Routes>
        <Route path="/empleado/verificar/:token" element={<EmpleadoVerificarPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('EmpleadoVerificarPage', () => {
  beforeEach(() => apiFetch.mockReset());

  it('confirma el mail sin login y ofrece ir a iniciar sesión', async () => {
    apiFetch.mockResolvedValue({ message: 'Listo' });
    renderPage();
    expect(await screen.findByText(/¡Listo! Tu mail quedó confirmado/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute('href', '/empleado/login');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/public/empleado/verificar', expect.objectContaining({
      method: 'POST',
      token: null,
      body: { token: TOKEN }
    }));
  });

  it('si el link venció explica cómo pedir uno nuevo', async () => {
    const err = new Error('El link de confirmación venció.');
    err.status = 410;
    apiFetch.mockRejectedValue(err);
    renderPage();
    expect(await screen.findByText(/El link venció o ya se usó/)).toBeInTheDocument();
    expect(screen.getByText(/Reenviar mail/)).toBeInTheDocument();
  });

  it('si el link ya se usó (400) muestra el mismo aviso', async () => {
    const err = new Error('El link de confirmación no es válido o ya se usó.');
    err.status = 400;
    apiFetch.mockRejectedValue(err);
    renderPage();
    expect(await screen.findByText(/El link venció o ya se usó/)).toBeInTheDocument();
  });
});
