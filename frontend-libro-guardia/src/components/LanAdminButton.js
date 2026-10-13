import React, { useState } from 'react';
import { Settings } from 'lucide-react';
import { useRuntime } from '../context/RuntimeContext';
import { Modal } from './admin-ui/Modal';
import brand from '../config/brand';
import { adminPath, getDefaultAdminSection } from '../utils/navigation';

const NEW_TAB_HINT = 'Se abre en una pestaña nueva. Puede pedirte que vuelvas a entrar con tu usuario.';

/** Botón Administración en la central del predio: abre la admin en la nube. */
export default function LanAdminButton({ currentUser, onDone }) {
  const { mode, cloudOnline } = useRuntime();
  const [offlineOpen, setOfflineOpen] = useState(false);

  if (mode !== 'lan') return null;

  const handleClick = () => {
    if (cloudOnline === false) {
      setOfflineOpen(true);
      return;
    }
    const url = `${brand.publicOrigin}${adminPath(getDefaultAdminSection(currentUser))}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    onDone?.();
  };

  const closeOffline = () => {
    setOfflineOpen(false);
    onDone?.();
  };

  return (
    <>
      <button
        type="button"
        className="btn-admin-panel"
        onClick={handleClick}
        title={cloudOnline === false ? undefined : NEW_TAB_HINT}
      >
        <Settings size={16} /> Administración
      </button>
      <Modal
        open={offlineOpen}
        title="Administración sin internet"
        onClose={closeOffline}
        size="sm"
        footer={(
          <button type="button" className="btn btn-primary" onClick={closeOffline}>
            Entendido
          </button>
        )}
      >
        <p>
          La administración necesita internet porque guarda los cambios en la nube.
          Las puertas, lectores y alarmas siguen funcionando normalmente en el predio.
          Probá de nuevo cuando vuelva la conexión.
        </p>
      </Modal>
    </>
  );
}
