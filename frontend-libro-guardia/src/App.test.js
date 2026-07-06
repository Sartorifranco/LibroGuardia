import { render, screen } from '@testing-library/react';
import App from './App';

test('muestra la pantalla de login', () => {
  render(<App />);
  expect(screen.getByText(/Libro Novedades Bacar sa\./i)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /Iniciar Sesión/i })).toBeInTheDocument();
});
