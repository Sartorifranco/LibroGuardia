import React, { useEffect, useState } from 'react';
import { DoorOpen } from 'lucide-react';
import { hasPermission } from '../utils/permissions';
import { useConfirm } from '../context/ConfirmContext';
import { apiFetch } from '../services/api';

function ManualDoorButton({
  authToken,
  currentUser,
  variant = 'header',
  doorId = null,
  onSuccess,
  onError
}) {
  const { confirm } = useConfirm();
  const [opening, setOpening] = useState(false);
  const [doors, setDoors] = useState([]);
  const [selectedDoorId, setSelectedDoorId] = useState(doorId || '');

  useEffect(() => {
    if (!authToken || !hasPermission(currentUser, 'access.manual_open')) return;
    apiFetch('/guard/doors', { token: authToken, allowForbidden: true })
      .then((data) => {
        const list = (data.doors || []).filter((door) => door.manualOpenAllowed !== false);
        setDoors(list);
        if (!selectedDoorId && list.length) {
          setSelectedDoorId(data.defaultDoorId || list[0].id);
        }
      })
      .catch(() => {});
  }, [authToken, currentUser, selectedDoorId]);

  if (!currentUser || !hasPermission(currentUser, 'access.manual_open')) {
    return null;
  }

  const handleOpen = async () => {
    if (opening) return;
    const targetDoor = doors.find((door) => door.id === selectedDoorId);
    const label = targetDoor?.name || 'la puerta';
    const ok = await confirm({
      title: 'Apertura manual',
      message: `¿Abrir ${label} manualmente? La puerta se accionará de inmediato.`,
      confirmLabel: 'Abrir puerta',
      tone: 'default'
    });
    if (!ok) return;

    setOpening(true);
    try {
      const data = await apiFetch('/guard/open-door', {
        method: 'POST',
        token: authToken,
        body: {
          reason: 'apertura_manual_guardia',
          doorId: selectedDoorId || null,
          bypassAirlock: true
        }
      });
      onSuccess?.(data.message || `${label} abierta`);
    } catch (err) {
      onError?.(err.message || 'Error al abrir la puerta');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className={`manual-door-control manual-door-control--${variant}`}>
      {doors.length > 1 && (
        <select
          className="manual-door-select"
          value={selectedDoorId}
          onChange={(e) => setSelectedDoorId(e.target.value)}
          aria-label="Seleccionar puerta"
        >
          {doors.map((door) => (
            <option key={door.id} value={door.id}>{door.name || door.id}</option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={`btn-manual-door btn-manual-door--${variant}`}
        onClick={handleOpen}
        disabled={opening}
        title="Abrir puerta manualmente (SR201)"
      >
        <DoorOpen size={variant === 'kiosk' ? 22 : 18} />
        <span>{opening ? 'Abriendo...' : 'Abrir puerta'}</span>
      </button>
    </div>
  );
}

export default ManualDoorButton;
