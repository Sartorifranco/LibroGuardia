import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import LanAdminButton from './LanAdminButton';
import { useRuntime } from '../context/RuntimeContext';
import brand from '../config/brand';
import { adminPath, getDefaultAdminSection } from '../utils/navigation';

jest.mock('../context/RuntimeContext', () => ({
  useRuntime: jest.fn()
}));

const user = { username: 'admin', role: 'admin' };

describe('LanAdminButton', () => {
  let openSpy;

  beforeEach(() => {
    openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('con internet abre la administración de la nube en una pestaña nueva', () => {
    useRuntime.mockReturnValue({ mode: 'lan', isLan: true, cloudOnline: true });
    const onDone = jest.fn();
    render(<LanAdminButton currentUser={user} onDone={onDone} />);

    const button = screen.getByRole('button', { name: /Administración/ });
    expect(button).toHaveAttribute('title', expect.stringContaining('Se abre en una pestaña nueva'));
    fireEvent.click(button);

    const url = `${brand.publicOrigin}${adminPath(getDefaultAdminSection(user))}`;
    expect(openSpy).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('sin internet muestra el aviso y Entendido lo cierra', () => {
    useRuntime.mockReturnValue({ mode: 'lan', isLan: true, cloudOnline: false });
    render(<LanAdminButton currentUser={user} onDone={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Administración/ }));

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Administración sin internet')).toBeInTheDocument();
    expect(screen.getByText(/necesita internet porque guarda los cambios en la nube/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('en modo nube no muestra nada', () => {
    useRuntime.mockReturnValue({ mode: 'cloud', isLan: false, cloudOnline: true });
    const { container } = render(<LanAdminButton currentUser={user} onDone={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
