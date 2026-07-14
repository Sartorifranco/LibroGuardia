import React, { useEffect, useState } from 'react';
import { DoorOpen } from 'lucide-react';
import { hasPermission } from '../utils/permissions';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

function ManualDoorButton({
  authToken,
  currentUser,
  variant = 'header',
  doorId = null,
  onSuccess,
  onError
}) {
  const [opening, setOpening] = useState(false);
  const [doors, setDoors] = useState([]);
  const [selectedDoorId, setSelectedDoorId] = useState(doorId || '');

  useEffect(() => {
    if (!authToken || !hasPermission(currentUser, 'access.manual_open')) return;
    fetch(`${API_BASE_URL}/guard/doors`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })
      .then((res) => res.json())
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
    if (!window.confirm(`¿Abrir ${label} manualmente?`)) return;

    setOpening(true);
    try {
      const response = await fetch(`${API_BASE_URL}/guard/open-door`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          reason: 'apertura_manual_guardia',
          doorId: selectedDoorId || null,
          bypassAirlock: true
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'No se pudo abrir la puerta');
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
