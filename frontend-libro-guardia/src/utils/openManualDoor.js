/**
 * Apertura manual de puerta — nube y/o estación LAN.
 *
 * Estrategia:
 * - relayMode:'local' + datos de estación → POST directo a la estación (PASO 6).
 * - Si la nube falla y hay estación → fallback LAN (PASO 5).
 * - relayMode:'cloud' (o sin estación) → POST /guard/open-door como siempre.
 */
import { apiFetch } from '../services/api';
import { openDoorOnStation } from './localStationClient';

const isNetworkishError = (err) => {
  const msg = String(err?.message || err || '');
  return /timeout|network|Failed to fetch|NetworkError|ECONN|offline|AbortError|sin conexión/i.test(msg);
};

export async function openManualDoor({
  authToken,
  doorId,
  door = null,
  reason = 'apertura_manual_guardia',
  bypassAirlock = true,
  /** Forzar solo nube (tests / admin). */
  forceCloud = false,
  /** Forzar solo LAN. */
  forceLocal = false
} = {}) {
  const id = String(doorId || door?.id || '').trim();
  if (!id) throw new Error('No hay puerta seleccionada');

  const station = door?.localStation || null;
  const relayMode = door?.relayMode === 'local' ? 'local' : 'cloud';
  const canLocal = Boolean(
    station?.direccionRedLocal
    && station?.secretoLocal
    && station?.puertoServidorLocal
  );

  const openLocal = async () => {
    const res = await openDoorOnStation(station, id);
    if (!res.ok) {
      const err = new Error(res.data?.message || `Estación local HTTP ${res.status}`);
      err.status = res.status;
      err.via = 'local';
      throw err;
    }
    return {
      message: res.data?.message || 'Puerta abierta por red local',
      via: 'local',
      doorId: id,
      relay: res.data?.relay || null
    };
  };

  const openCloud = async () => {
    if (!authToken) throw new Error('Sin sesión');
    const data = await apiFetch('/guard/open-door', {
      method: 'POST',
      token: authToken,
      body: { reason, doorId: id, bypassAirlock }
    });
    return { ...data, via: data.via || 'cloud' };
  };

  if (forceLocal) {
    if (!canLocal) throw new Error('Sin datos de estación local para esta puerta');
    return openLocal();
  }

  if (forceCloud) {
    return openCloud();
  }

  // PASO 6: con internet, puertas local van directo a la estación.
  if (relayMode === 'local' && canLocal) {
    try {
      return await openLocal();
    } catch (localErr) {
      // Si la estación no responde, intentar nube por si el bridge aún pollea.
      try {
        return await openCloud();
      } catch (cloudErr) {
        const err = new Error(
          localErr.message || cloudErr.message || 'No se pudo abrir (local ni nube)'
        );
        err.via = 'local';
        err.causeLocal = localErr;
        err.causeCloud = cloudErr;
        throw err;
      }
    }
  }

  // Camino nube (default) con fallback LAN si la red/API falla (PASO 5).
  try {
    return await openCloud();
  } catch (cloudErr) {
    if (canLocal && isNetworkishError(cloudErr)) {
      try {
        return await openLocal();
      } catch (localErr) {
        const err = new Error(
          `Sin nube y estación local falló: ${localErr.message}`
        );
        err.via = 'local';
        throw err;
      }
    }
    throw cloudErr;
  }
}
