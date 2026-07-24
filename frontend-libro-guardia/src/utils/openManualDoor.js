/**
 * Apertura manual de puerta — nube y/o estación LAN.
 *
 * Estrategia:
 * - relayMode:'local' + datos de estación → POST directo a la estación (PASO 6).
 * - Si la nube falla y hay estación → fallback LAN (PASO 5).
 * - relayMode:'cloud' (o sin estación) → POST /guard/open-door como siempre.
 *
 * NOTA: /guard/open-door NO usa la colección `estaciones`. Dispara el relé
 * desde la Cloud Function (bridgeUrl/TCP). Sin `localStation` en el objeto
 * puerta, este cliente NUNCA habla con el HTTP local del bridge.
 */
import { apiFetch } from '../services/api';
import { openDoorOnStation } from './localStationClient';

/** TEMP auditoría: último camino de apertura (consola + sessionStorage). Quitar tras prueba. */
export const OPEN_DOOR_AUDIT_KEY = 'lg.audit.openManualDoor.last';

const isNetworkishError = (err) => {
  const msg = String(err?.message || err || '');
  return /timeout|network|Failed to fetch|NetworkError|ECONN|offline|AbortError|sin conexión/i.test(msg);
};

const writeOpenAudit = (entry) => {
  const payload = {
    at: new Date().toISOString(),
    ...entry
  };
  try {
    // eslint-disable-next-line no-console
    console.info('[openManualDoor:audit]', payload);
    sessionStorage.setItem(OPEN_DOOR_AUDIT_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
  return payload;
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

  const baseAudit = {
    doorId: id,
    relayMode,
    forceLocal: Boolean(forceLocal),
    forceCloud: Boolean(forceCloud),
    canLocal,
    hasLocalStation: Boolean(station),
    estacionId: station?.estacionId || null,
    direccionRedLocal: station?.direccionRedLocal || null
  };

  const openLocal = async (pathLabel) => {
    writeOpenAudit({ ...baseAudit, attempt: pathLabel, phase: 'local_fetch_start' });
    const res = await openDoorOnStation(station, id);
    if (!res.ok) {
      const err = new Error(res.data?.message || `Estación local HTTP ${res.status}`);
      err.status = res.status;
      err.via = 'local';
      writeOpenAudit({
        ...baseAudit,
        attempt: pathLabel,
        ok: false,
        via: 'local',
        httpStatus: res.status,
        error: err.message
      });
      throw err;
    }
    const result = {
      message: res.data?.message || 'Puerta abierta por red local',
      via: 'local',
      doorId: id,
      relay: res.data?.relay || null,
      auditPath: pathLabel
    };
    writeOpenAudit({ ...baseAudit, attempt: pathLabel, ok: true, via: 'local' });
    return result;
  };

  const openCloud = async (pathLabel) => {
    if (!authToken) throw new Error('Sin sesión');
    writeOpenAudit({ ...baseAudit, attempt: pathLabel, phase: 'cloud_fetch_start' });
    const data = await apiFetch('/guard/open-door', {
      method: 'POST',
      token: authToken,
      body: { reason, doorId: id, bypassAirlock }
    });
    const result = {
      ...data,
      via: data.via || 'cloud',
      auditPath: pathLabel
    };
    writeOpenAudit({
      ...baseAudit,
      attempt: pathLabel,
      ok: true,
      via: result.via,
      relayVia: data?.relay?.via || null
    });
    return result;
  };

  if (forceLocal) {
    if (!canLocal) {
      writeOpenAudit({
        ...baseAudit,
        attempt: 'forceLocal',
        ok: false,
        error: 'Sin datos de estación local para esta puerta'
      });
      throw new Error('Sin datos de estación local para esta puerta');
    }
    return openLocal('forceLocal');
  }

  if (forceCloud) {
    return openCloud('forceCloud');
  }

  // PASO 6: con internet, puertas local van directo a la estación.
  if (relayMode === 'local' && canLocal) {
    try {
      return await openLocal('relayLocal_preferStation');
    } catch (localErr) {
      // Si la estación no responde, intentar nube por si el bridge aún pollea.
      try {
        return await openCloud('relayLocal_fallbackCloud');
      } catch (cloudErr) {
        const err = new Error(
          localErr.message || cloudErr.message || 'No se pudo abrir (local ni nube)'
        );
        err.via = 'local';
        err.causeLocal = localErr;
        err.causeCloud = cloudErr;
        writeOpenAudit({
          ...baseAudit,
          attempt: 'relayLocal_bothFailed',
          ok: false,
          error: err.message
        });
        throw err;
      }
    }
  }

  // Camino nube (default) con fallback LAN si la red/API falla (PASO 5).
  // Importante: sin canLocal (0 estaciones / sin localStation), SOLO nube.
  try {
    return await openCloud(
      relayMode === 'local' && !canLocal
        ? 'cloudOnly_localModeWithoutStation'
        : 'cloudDefault'
    );
  } catch (cloudErr) {
    if (canLocal && isNetworkishError(cloudErr)) {
      try {
        return await openLocal('cloudFailed_fallbackLocal');
      } catch (localErr) {
        const err = new Error(
          `Sin nube y estación local falló: ${localErr.message}`
        );
        err.via = 'local';
        writeOpenAudit({
          ...baseAudit,
          attempt: 'cloudFailed_fallbackLocal',
          ok: false,
          error: err.message
        });
        throw err;
      }
    }
    writeOpenAudit({
      ...baseAudit,
      attempt: 'cloudOnly_failed',
      ok: false,
      error: cloudErr.message,
      isNetworkError: Boolean(cloudErr.isNetworkError || isNetworkishError(cloudErr))
    });
    throw cloudErr;
  }
}
