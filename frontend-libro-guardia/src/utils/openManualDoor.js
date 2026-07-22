/**
 * Apertura manual de puerta — misma llamada que ManualDoorButton / botonera.
 */
import { apiFetch } from '../services/api';

export async function openManualDoor({
  authToken,
  doorId,
  reason = 'apertura_manual_guardia',
  bypassAirlock = true
}) {
  if (!authToken) {
    throw new Error('Sin sesión');
  }
  if (!doorId) {
    throw new Error('No hay puerta seleccionada');
  }
  return apiFetch('/guard/open-door', {
    method: 'POST',
    token: authToken,
    body: {
      reason,
      doorId,
      bypassAirlock
    }
  });
}
