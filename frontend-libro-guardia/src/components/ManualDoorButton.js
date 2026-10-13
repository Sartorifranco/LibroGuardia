import React, { useEffect, useRef, useState } from 'react';
import { DoorOpen } from 'lucide-react';
import { hasPermission } from '../utils/permissions';
import { useConfirm } from '../context/ConfirmContext';
import { apiFetch } from '../services/api';
import { openManualDoorWithAirlock } from '../utils/openManualDoor';
import { doorOpenUserMessage } from '../utils/doorOpenStatus';

function ManualDoorButton({
  authToken,
  currentUser,
  variant = 'header',
  doorId = null,
  onSuccess,
  onError
}) {
  const { confirm, confirmWithReason } = useConfirm();
  const openingLockRef = useRef(false);
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
    if (openingLockRef.current || opening) return;
    if (!selectedDoorId) {
      onError?.(loadError || 'No hay puerta seleccionada. Guardá puertas en Admin → Puertas y acceso.');
      return;
    }
    openingLockRef.current = true;
    const targetDoor = doors.find((door) => door.id === selectedDoorId);
    const label = targetDoor?.name || selectedDoorId;
    try {
      const ok = await confirm({
        title: 'Abrir puerta',
        message: `¿Abrir la puerta ${label}?`,
        confirmLabel: 'Abrir puerta',
        tone: 'danger'
      });
      if (!ok) return;

      setOpening(true);
      try {
        // 409 estanco: muestra el motivo; con puertas.estanco.forzar ofrece forzar con motivo.
        const data = await openManualDoorWithAirlock({
          canForceAirlock: hasPermission(currentUser, 'puertas.estanco.forzar'),
          confirmWithReason,
          authToken,
          doorId: selectedDoorId
        });
        if (!data?.cancelled) onSuccess?.(doorOpenUserMessage(data, label));
      } catch (err) {
        onError?.(err.message || 'Error al abrir la puerta');
      } finally {
        setOpening(false);
      }
    } finally {
      openingLockRef.current = false;
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
              {door.name || 'Puerta'}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={`btn-manual-door btn-manual-door--${variant}`}
        onClick={handleOpen}
        disabled={opening || !selectedDoorId}
        title={selectedDoorId ? 'Abrir la puerta' : (loadError || 'Sin puertas configuradas')}
      >
        <DoorOpen size={variant === 'kiosk' ? 22 : 18} />
        <span>{opening ? 'Abriendo...' : 'Abrir puerta'}</span>
      </button>
    </div>
  );
}

export default ManualDoorButton;
