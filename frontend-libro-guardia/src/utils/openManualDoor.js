/**
 * Apertura manual de puerta.
 *
 * Camino único (casi siempre): POST /guard/open-door por HTTPS.
 * - relayMode cloud → la nube dispara por túnel.
 * - relayMode local → la nube encola; el bridge de planta abre por LAN (~2 s).
 *
 * forceLocal: solo diagnóstico (HTTP directo a la estación; Mixed Content en HTTPS).
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
  /** Forzar solo nube/cola (default). */
  forceCloud = false,
  /** Forzar HTTP LAN directo (diagnóstico). */
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

  const openLocalDirect = async (pathLabel) => {
    writeOpenAudit({ ...baseAudit, attempt: pathLabel, phase: 'local_fetch_start' });
    const host = String(door?.device?.host || '').trim();
    const localRelay = host
      ? {
        host,
        port: Number(door.device?.port) || 6722,
        channel: Number(door.device?.channel) === 2 ? 2 : 1,
        pulseMode: 'timed',
        pulseSeconds: Math.max(1, Math.min(99, Number(door.pulseSeconds) || 3))
      }
      : undefined;
    const res = await openDoorOnStation(station, id, { localRelay });
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

  const openCloudOrQueue = async (pathLabel) => {
    if (!authToken) throw new Error('Sin sesión');
    writeOpenAudit({ ...baseAudit, attempt: pathLabel, phase: 'cloud_fetch_start' });
    const data = await apiFetch('/guard/open-door', {
      method: 'POST',
      token: authToken,
      body: { reason, doorId: id, bypassAirlock }
    });
    const via = data?.relay?.via || data?.via || 'cloud';
    const result = {
      ...data,
      via,
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
    return openLocalDirect('forceLocal');
  }

  // Camino normal: HTTPS → API (cola local o túnel cloud). Un clic.
  try {
    return await openCloudOrQueue(
      forceCloud
        ? 'forceCloud'
        : (relayMode === 'local' ? 'localViaQueue' : 'cloudDefault')
    );
  } catch (cloudErr) {
    // Fallback LAN solo si la API no responde y hay estación (misma red).
    if (canLocal && isNetworkishError(cloudErr) && !forceCloud) {
      try {
        return await openLocalDirect('cloudFailed_fallbackLocal');
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
