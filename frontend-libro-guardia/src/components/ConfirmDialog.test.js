import React from 'react';
import { render, screen } from '@testing-library/react';
import ConfirmDialog from './ConfirmDialog';

function renderDialog(extra = {}) {
  return render(
    <ConfirmDialog
      open
      title="Abrir puerta"
      message="¿Abrir la puerta Molinete?"
      confirmLabel="Abrir puerta"
      cancelLabel="Cancelar"
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
      {...extra}
    />
  );
}

describe('ConfirmDialog', () => {
  test('el foco inicial queda en Cancelar, no en confirmar', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Abrir puerta' })).not.toHaveFocus();
  });

  test('autoFocusConfirm pone el foco en el botón de confirmar', () => {
    renderDialog({ autoFocusConfirm: true });
    expect(screen.getByRole('button', { name: 'Abrir puerta' })).toHaveFocus();
  });
});
