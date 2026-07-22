import React, { useEffect, useState } from 'react';
import { DoorOpen } from 'lucide-react';
import { hasPermission } from '../utils/permissions';
import { useConfirm } from '../context/ConfirmContext';
import { apiFetch } from '../services/api';
import { openManualDoor } from '../utils/openManualDoor';

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
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (doorId) setSelectedDoorId(doorId);
  }, [doorId]);

  useEffect(() => {
    if (!authToken || !hasPermission(currentUser, 'access.manual_open')) return undefined;
    let cancelled = false;
    apiFetch('/guard/doors', { token: authToken, allowForbidden: true })
      .then((data) => {
        if (cancelled) return;
        const list = (data.doors || []).filter((door) => door.manualOpenAllowed !== false);
        setDoors(list);
        setLoadError(list.length ? '' : 'No hay puertas activas. Configuralas en Admin → Puertas y acceso.');
        setSelectedDoorId((prev) => {
          if (doorId && list.some((d) => d.id === doorId)) return doorId;
          if (prev && list.some((d) => d.id === prev)) return prev;
          if (data.defaultDoorId && list.some((d) => d.id === data.defaultDoorId)) {
            return data.defaultDoorId;
          }
          return list[0]?.id || '';
        });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || 'No se pudieron cargar las puertas');
      });
    return () => { cancelled = true; };
  }, [authToken, currentUser, doorId]);

  if (!currentUser || !hasPermission(currentUser, 'access.manual_open')) {
    return null;
  }

  const handleOpen = async () => {
    if (opening) return;
    if (!selectedDoorId) {
      onError?.(loadError || 'No hay puerta seleccionada. Guardá puertas en Admin → Puertas y acceso.');
      return;
    }
    const targetDoor = doors.find((door) => door.id === selectedDoorId);
    const label = targetDoor?.name || selectedDoorId;
    const ok = await confirm({
      title: 'Apertura manual',
      message: `¿Abrir ${label} manualmente? Se enviará el pulso al relé de esa puerta.`,
      confirmLabel: 'Abrir puerta',
      tone: 'default'
    });
    if (!ok) return;

    setOpening(true);
    try {
      const data = await openManualDoor({
        authToken,
        doorId: selectedDoorId
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
            <option key={door.id} value={door.id}>
              {door.name || door.id}
              {door.device?.channel ? ` · CH${door.device.channel}` : ''}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={`btn-manual-door btn-manual-door--${variant}`}
        onClick={handleOpen}
        disabled={opening || !selectedDoorId}
        title={selectedDoorId ? 'Abrir puerta manualmente (SR201)' : (loadError || 'Sin puertas configuradas')}
      >
        <DoorOpen size={variant === 'kiosk' ? 22 : 18} />
        <span>{opening ? 'Abriendo...' : 'Abrir puerta'}</span>
      </button>
    </div>
  );
}

export default ManualDoorButton;
