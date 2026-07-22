import {
  hotkeySlotFromEvent,
  doorIdForHotkeySlot,
  loadDoorHotkeys
} from './doorHotkeys';
import { openManualDoor } from './openManualDoor';

/**
 * Dispara apertura por atajo usando la misma función que el botón.
 * @returns {{ handled: boolean, slot?: number, doorId?: string, result?: object, error?: string }}
 */
export async function handleDoorHotkeyOpen({
  event,
  authToken,
  doors = [],
  hotkeys = null,
  confirmFn = null,
  skipConfirm = false
}) {
  const slot = hotkeySlotFromEvent(event);
  if (!slot) return { handled: false };

  event.preventDefault?.();
  event.stopPropagation?.();

  const map = hotkeys || loadDoorHotkeys();
  const doorId = doorIdForHotkeySlot(slot, map);
  if (!doorId) {
    return { handled: true, slot, error: `Atajo Ctrl+Alt+${slot} sin puerta asignada` };
  }

  const door = doors.find((d) => d.id === doorId);
  if (!door) {
    return { handled: true, slot, doorId, error: 'La puerta del atajo ya no está disponible' };
  }

  if (!skipConfirm && typeof confirmFn === 'function') {
    const ok = await confirmFn({
      title: 'Apertura por atajo',
      message: `¿Abrir ${door.name || doorId} (Ctrl+Alt+${slot})?`,
      confirmLabel: 'Abrir puerta',
      tone: 'default'
    });
    if (!ok) return { handled: true, slot, doorId, cancelled: true };
  }

  try {
    const result = await openManualDoor({ authToken, doorId });
    return { handled: true, slot, doorId, result };
  } catch (err) {
    return { handled: true, slot, doorId, error: err.message || 'Error al abrir' };
  }
}
