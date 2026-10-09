/** Estado real de la hoja, en palabras simples para el guardia. */
const DOOR_LIVE_LABELS = {
  SEGURA: { label: 'Cerrada', tone: 'ok' },
  DESBLOQUEADA: { label: 'Abierta', tone: 'open' },
  ABIERTA_AUT: { label: 'Abierta demasiado tiempo', tone: 'warn' },
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
  const next = doors.slice();
  next[idx] = {
    ...prev,
    id: prev.id,
    name: door.name || prev.name,
    live: door.live ? { ...(prev.live || {}), ...door.live } : prev.live,
    health: door.health ? { ...(prev.health || {}), ...door.health } : prev.health,
    lastPulse: door.lastPulse || prev.lastPulse,
    airlock: door.airlock !== undefined ? door.airlock : prev.airlock
  };
  return next;
}
