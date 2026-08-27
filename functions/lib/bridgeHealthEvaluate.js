/**
 * Evaluación pura de heartbeat (sin Firestore).
 * Umbrales: los mismos que lectores (10 min en línea / 30 min desconectado).
 */

const STATUS_GREEN_MS = 10 * 60 * 1000;
const STATUS_YELLOW_MS = 30 * 60 * 1000;
const RENOTIFY_MS = 6 * 60 * 60 * 1000;

const toMillis = (ultimaConexion) => {
  if (!ultimaConexion) return null;
  if (typeof ultimaConexion.toMillis === 'function') return ultimaConexion.toMillis();
  if (ultimaConexion._seconds != null) return ultimaConexion._seconds * 1000;
  if (ultimaConexion.seconds != null) return ultimaConexion.seconds * 1000;
  const n = Number(ultimaConexion);
  if (Number.isFinite(n) && n > 1e12) return n;
  const parsed = Date.parse(ultimaConexion);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveHeartbeatStatus = (ultimaConexion, nowMs = Date.now()) => {
  const ts = toMillis(ultimaConexion);
  if (ts == null) return 'offline';
  const age = nowMs - ts;
  if (age <= STATUS_GREEN_MS) return 'online';
  if (age <= STATUS_YELLOW_MS) return 'stale';
  return 'offline';
};

const toBridgeRow = ({ kind, id, name, lastAt, enabled = true }) => {
  const status = resolveHeartbeatStatus(lastAt);
  return {
    kind,
    id,
    name,
    lastAt: lastAt || null,
    enabled: enabled !== false,
    status,
    everSeen: Boolean(lastAt)
  };
};

const shouldAlertOffline = (row, prev = {}, nowMs = Date.now()) => {
  if (!row.enabled) return false;
  if (!row.everSeen) return false;
  if (row.status !== 'offline') return false;
  const lastNotified = prev.lastNotifiedAt ? Number(prev.lastNotifiedAt) : 0;
  if (prev.lastStatus !== 'offline') return true;
  return !lastNotified || (nowMs - lastNotified) >= RENOTIFY_MS;
};

module.exports = {
  STATUS_GREEN_MS,
  STATUS_YELLOW_MS,
  RENOTIFY_MS,
  resolveHeartbeatStatus,
  toBridgeRow,
  shouldAlertOffline
};
