import { render, screen } from '@testing-library/react';
import App from './App';

test('muestra la pantalla de login', async () => {
  render(<App />);
  expect(await screen.findByRole('heading', { name: /Libro de Novedades/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Entrar al sistema/i })).toBeInTheDocument();
});
