import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Modal from './Modal';
import WizardModal from './WizardModal';
import PageContainer from './PageContainer';

function installMatchMedia(matches) {
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn()
  }));
}

describe('Modal', () => {
  beforeEach(() => {
    installMatchMedia(false);
  });

  it('cierra con Escape y con la X', () => {
    const onClose = jest.fn();
    render(
      <Modal open title="Editar feriado" onClose={onClose}>
        <input aria-label="Nombre" />
      </Modal>
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('pregunta antes de descartar si hay cambios', () => {
    const onClose = jest.fn();
    render(
      <Modal
        open
        dirty
        title="Editar"
        onClose={onClose}
        footer={<button type="button" onClick={onClose}>Cancelar</button>}
      >
        <input aria-label="Nombre" />
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('¿Descartar los cambios?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
    expect(screen.queryByText('¿Descartar los cambios?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pone el foco en el primer campo y lo atrapa dentro', () => {
    render(
      <Modal
        open
        title="Editar"
        onClose={() => {}}
        footer={<button type="button">Guardar</button>}
      >
        <input aria-label="Nombre" />
        <input aria-label="Detalle" />
      </Modal>
    );
    const nombre = screen.getByLabelText('Nombre');
    const guardar = screen.getByRole('button', { name: 'Guardar' });
    const cerrar = screen.getByRole('button', { name: 'Cerrar' });
    expect(nombre).toHaveFocus();
    guardar.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cerrar).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(guardar).toHaveFocus();
  });

  it('usa el ancho pedido y en celular ocupa toda la pantalla', () => {
    const { unmount } = render(
      <Modal open title="Grande" size="lg" onClose={() => {}}>
        <input aria-label="Nombre" />
      </Modal>
    );
    const desktop = screen.getByRole('dialog');
    expect(desktop).toHaveAttribute('data-size', 'lg');
    expect(desktop).toHaveStyle({ maxWidth: '880px' });
    expect(desktop).not.toHaveClass('aui-modal--full');
    unmount();

    installMatchMedia(true);
    render(
      <Modal open title="Celular" size="sm" onClose={() => {}}>
        <input aria-label="Nombre" />
      </Modal>
    );
    const mobile = screen.getByRole('dialog');
    expect(mobile).toHaveClass('aui-modal--full');
    expect(mobile).toHaveStyle({ width: '100%', maxWidth: 'none', height: '100%' });
  });
});

describe('WizardModal', () => {
  beforeEach(() => {
    installMatchMedia(false);
  });

  it('avanza, vuelve y termina', () => {
    const onFinish = jest.fn();
    const onClose = jest.fn();
    render(
      <WizardModal
        open
        title="Alta"
        onClose={onClose}
        onFinish={onFinish}
        finishLabel="Crear"
        steps={[
          { id: 'a', title: 'Primero', content: <p>Paso uno</p>, canContinue: true },
          { id: 'b', title: 'Segundo', content: <input aria-label="Nota" />, canContinue: true }
        ]}
      />
    );
    expect(screen.getByText('Paso uno')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(screen.getByLabelText('Nota')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(screen.getByText('Paso uno')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('PageContainer', () => {
  it('limita el ancho según la variante', () => {
    const { container } = render(
      <PageContainer width="narrow"><p>Ficha</p></PageContainer>
    );
    expect(container.firstChild).toHaveClass('aui-page--narrow');
  });
});
