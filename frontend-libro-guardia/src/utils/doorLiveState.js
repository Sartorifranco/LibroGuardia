/** Estado real de la hoja, en palabras simples para el guardia. */
const DOOR_LIVE_LABELS = {
  SEGURA: { label: 'Cerrada', tone: 'ok' },
  DESBLOQUEADA: { label: 'Destrabada', tone: 'open' },
  ABIERTA_AUT: { label: 'Abierta', tone: 'open' },
  RETENIDA: { label: 'Abierta demasiado tiempo', tone: 'warn' },
  FORZADA: { label: 'FORZADA', tone: 'danger' },
  FALLA: { label: 'Falla de cerradura', tone: 'danger' },
  SIN_CONEXION: { label: 'Sin conexión', tone: 'offline' }
};

export function doorLivePresentation(door = {}) {
  const state = String(door?.live?.state || '').toUpperCase();
  const known = DOOR_LIVE_LABELS[state] || null;
  const healthStatus = String(door?.health?.status || '').toLowerCase();
  let label = known?.label || '';
  let tone = known?.tone || 'neutral';

  if (!label && (healthStatus === 'offline' || healthStatus === 'problem')) {
    label = healthStatus === 'offline' ? 'Sin conexión' : 'Falla de cerradura';
    tone = healthStatus === 'offline' ? 'offline' : 'danger';
  }

  const reason = healthStatus && healthStatus !== 'online'
    ? String(door?.health?.reason || '').trim()
    : '';

  return { label, tone, reason, hasLive: Boolean(label) };
}

/** El SSE manda `{doorId, state, dps, bond, since}`; un refresh puede mandar `live`. */
function liveFromEvent(door) {
  if (door.live && typeof door.live === 'object') return door.live;
  if (door.state == null && door.dps === undefined && door.bond === undefined && door.since == null) return null;
  const patch = {};
  if (door.state != null) patch.state = door.state;
  if (door.dps !== undefined) patch.dps = door.dps;
  if (door.bond !== undefined) patch.bond = door.bond;
  if (door.since != null) patch.since = door.since;
  return patch;
}

export function applyDoorLiveEvent(doors = [], payload) {
  if (!payload || typeof payload !== 'object') return doors;
  const door = payload.door && typeof payload.door === 'object'
    ? { ...payload.door, ...payload }
    : payload;
  const id = door.id || door.doorId;
  if (!id) return doors;

  const idx = doors.findIndex((item) => item.id === id);
  if (idx < 0) {
    if (!door.live && !door.name) return doors;
    return [...doors, { ...door, id }];
  }

  const prev = doors[idx];
  const livePatch = liveFromEvent(door);
  const next = doors.slice();
  next[idx] = {
    ...prev,
    id: prev.id,
    name: door.name || prev.name,
    live: livePatch ? { ...(prev.live || {}), ...livePatch } : prev.live,
    health: door.health ? { ...(prev.health || {}), ...door.health } : prev.health,
    lastPulse: door.lastPulse || prev.lastPulse,
    airlock: door.airlock !== undefined ? door.airlock : prev.airlock
  };
  return next;
}
