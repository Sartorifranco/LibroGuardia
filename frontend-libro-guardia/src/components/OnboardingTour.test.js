import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import OnboardingTour, { isOnboardingDone, markOnboardingDone } from './OnboardingTour';

describe('OnboardingTour', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('Omitir y Cerrar quedan en el diálogo, Escape persiste por usuario', () => {
    const user = { username: 'guardia.turno' };
    const onClose = jest.fn();
    render(<OnboardingTour open user={user} onClose={onClose} />);

    expect(screen.getByRole('button', { name: 'Omitir' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar tutorial' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(isOnboardingDone(user)).toBe(true);
    expect(isOnboardingDone({ username: 'otro' })).toBe(false);
  });

  test('una vez cerrado no vuelve a figurar como pendiente', () => {
    const user = { id: 'u-1', username: 'ana' };
    markOnboardingDone(user);
    expect(isOnboardingDone(user)).toBe(true);
    expect(isOnboardingDone({ id: 'u-2' })).toBe(false);
  });
});
