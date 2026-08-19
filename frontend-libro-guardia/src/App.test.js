import { render, screen } from '@testing-library/react';
import App from './App';
import brand from './config/brand';

test('muestra la pantalla de login', async () => {
  window.history.pushState({}, '', '/login');
  render(<App />);
  expect(await screen.findByRole('heading', { name: brand.loginTitle })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Entrar al sistema/i })).toBeInTheDocument();
});
