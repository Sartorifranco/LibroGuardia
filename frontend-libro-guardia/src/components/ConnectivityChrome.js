import React from 'react';
import { useConfirm } from '../context/ConfirmContext';
import { useOfflineQueue } from '../context/OfflineQueueContext';
import { describeQueuedItem } from '../utils/offlineQueue';

function RejectedQueuePanel() {
  const { rejectedItems, retryRejected, discardRejected } = useOfflineQueue();
  const { confirm } = useConfirm();

  if (!rejectedItems.length) return null;

  const handleDiscard = async (item) => {
    const { label, key } = describeQueuedItem(item);
    const who = [label, key].filter(Boolean).join(' ');
    const ok = await confirm({
      title: 'Descartar registro',
      message: `Este registro no se va a enviar${who ? ` (${who})` : ''}. ¿Seguro que querés descartarlo?`,
      confirmLabel: 'Descartar',
      tone: 'danger'
    });
    if (!ok) return;
    await discardRejected(item.id);
  };

  return (
    <section id="rejected-queue-panel" className="rejected-queue" role="alert">
      {rejectedItems.map((item) => {
        const { label, key } = describeQueuedItem(item);
        const reason = item.rejectReason || 'El servidor no aceptó el registro';
        const who = [label, key].filter(Boolean).join(' ');
        return (
          <div key={item.id} className="rejected-queue__item">
            <p>No se pudo enviar: {who} — {reason}</p>
            <div className="rejected-queue__actions">
              <button type="button" className="btn btn-secondary" onClick={() => retryRejected(item.id)}>
                Reintentar
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => handleDiscard(item)}>
                Descartar
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Franja de sin conexión y avisos de registros que el servidor rechazó. */
function ConnectivityChrome() {
  const { isOnline } = useOfflineQueue();

  return (
    <>
      {!isOnline && (
        <>
          <div className="offline-connection-banner" role="status">
            Sin conexión a internet. Lo que cargues se guarda y se envía solo cuando vuelva.
          </div>
          <div className="offline-connection-banner__spacer" aria-hidden="true" />
        </>
      )}
      <RejectedQueuePanel />
    </>
  );
}

export default ConnectivityChrome;
