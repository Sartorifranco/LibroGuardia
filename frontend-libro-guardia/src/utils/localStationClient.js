/**
 * Cliente HTTP hacia el servidor local de una estación (door-reader-bridge).
 * Solo LAN — sin túnel. Auth: Bearer <secretoLocal>.
 */

const DEFAULT_TIMEOUT_MS = 4000;

const stationBaseUrl = (station) => {
  const host = String(station?.direccionRedLocal || '').trim();
  const port = Number(station?.puertoServidorLocal) || 8787;
  if (!host) throw new Error('Estación sin dirección de red local');
  return `http://${host}:${port}`;
};

const stationFetch = async (station, path, { method = 'GET', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const secret = String(station?.secretoLocal || '').trim();
  if (!secret) throw new Error('Estación sin secreto local');

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => {
    try { controller?.abort(); } catch { /* ignore */ }
  }, timeoutMs);

  try {
    const response = await fetch(`${stationBaseUrl(station)}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${secret}`
      },
      cache: 'no-store',
      signal: controller?.signal
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    return { status: response.status, ok: response.ok, data };
  } finally {
    clearTimeout(timer);
  }
};

export async function fetchStationStatus(station, options = {}) {
  return stationFetch(station, '/status', { method: 'GET', ...options });
}

export async function openDoorOnStation(station, doorId, options = {}) {
  const id = encodeURIComponent(String(doorId || '').trim());
  if (!id) throw new Error('doorId requerido');
  return stationFetch(station, `/open/${id}`, { method: 'POST', ...options });
}

/**
 * Une status de varias estaciones (únicas por estacionId) sobre la lista de puertas.
 */
export async function probeLocalStationsForDoors(doors = []) {
  const byEstacion = new Map();
  doors.forEach((door) => {
    const st = door?.localStation;
    if (!st?.estacionId || !st.direccionRedLocal || !st.secretoLocal) return;
    if (!byEstacion.has(st.estacionId)) {
      byEstacion.set(st.estacionId, { station: st, doorIds: [] });
    }
    byEstacion.get(st.estacionId).doorIds.push(door.id);
  });

  const results = [];
  for (const { station, doorIds } of byEstacion.values()) {
    try {
      const res = await fetchStationStatus(station);
      results.push({
        station,
        doorIds,
        ok: res.ok,
        status: res.status,
        readers: res.data?.readers || [],
        error: res.ok ? null : (res.data?.message || `HTTP ${res.status}`)
      });
    } catch (err) {
      results.push({
        station,
        doorIds,
        ok: false,
        status: 0,
        readers: [],
        error: err.message || 'fetch_failed'
      });
    }
  }
  return results;
}

/**
 * Aplica lecturas de /status a lastPulse-like para el panel (mejor esfuerzo).
 */
export function mergeStationStatusIntoDoors(doors = [], probeResults = []) {
  const readerByDoor = new Map();
  probeResults.forEach((probe) => {
    (probe.readers || []).forEach((r) => {
      if (r?.doorId) readerByDoor.set(r.doorId, { ...r, stationOk: probe.ok });
    });
  });

  return doors.map((door) => {
    const reader = readerByDoor.get(door.id);
    if (!reader) {
      return {
        ...door,
        localReachable: probeResults.some(
          (p) => p.ok && (p.doorIds || []).includes(door.id)
        )
      };
    }
    return {
      ...door,
      localReachable: Boolean(reader.stationOk),
      localReader: {
        connected: Boolean(reader.connected),
        lastScanAt: reader.lastScanAt || null,
        allowlistFresh: reader.allowlistFresh
      },
      lastPulse: door.lastPulse || (reader.lastScanAt
        ? { at: reader.lastScanAt, ok: true, type: 'local_status', message: 'Estado por red local' }
        : door.lastPulse)
    };
  });
}

export const GUARD_DOORS_CACHE_KEY = 'lg.guard.doors.cache.v1';

export function cacheGuardDoors(doors) {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      doors: (doors || []).map((d) => ({
        id: d.id,
        name: d.name,
        active: d.active,
        manualOpenAllowed: d.manualOpenAllowed,
        authMethods: d.authMethods,
        relayMode: d.relayMode,
        localStation: d.localStation || null
      }))
    };
    localStorage.setItem(GUARD_DOORS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota / private mode
  }
}

export function loadCachedGuardDoors() {
  try {
    const raw = localStorage.getItem(GUARD_DOORS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.doors)) return null;
    return parsed;
  } catch {
    return null;
  }
}
