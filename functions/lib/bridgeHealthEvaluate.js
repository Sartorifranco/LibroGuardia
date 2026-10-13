/**
 * Evaluación pura de heartbeat (sin Firestore).
 * Umbrales: los mismos que lectores (10 min en línea / 30 min desconectado).
 *
 * Además del heartbeat, cada puente puede reportar un "problema" (lector sin
 * conectar, relé que no responde, BioStar que no importa): la fila queda
 * 'degraded' aunque el proceso siga vivo.
 */

const STATUS_GREEN_MS = 10 * 60 * 1000;
const STATUS_YELLOW_MS = 30 * 60 * 1000;
const RENOTIFY_MS = 6 * 60 * 60 * 1000;
/** Un problema tiene que durar esto antes de mandar mail (evita avisos por cortes de segundos). */
const PROBLEM_GRACE_MS = 2 * 60 * 1000;
/** BioStar: sin una sincronización exitosa en este lapso → degradado. */
const BIOSTAR_SUCCESS_STALE_MS = 15 * 60 * 1000;

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

const AR_SHORT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

/** "15/08 03:54" en hora de Argentina. */
const formatArShort = (value) => {
  const ms = toMillis(value);
  if (ms == null) return '';
  const p = Object.fromEntries(
    AR_SHORT.formatToParts(new Date(ms)).map((part) => [part.type, part.value])
  );
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};

/**
 * Salud del puente BioStar a partir de su estado guardado.
 * Degradado si no hubo éxito en 15 min o si el último error es posterior al último éxito,
 * aunque los heartbeats sigan llegando.
 * @returns {{ status: 'online'|'stale'|'degraded'|'offline', reason: string|null,
 *   notice: string|null, problemCode: string|null, problemSince: number|null }}
 */
const evaluateBiostarHealth = (status = {}, nowMs = Date.now()) => {
  const base = { reason: null, notice: null, problemCode: null, problemSince: null };
  if (!status.lastHeartbeatAt) {
    return { ...base, status: 'offline', reason: 'El puente BioStar todavía no reportó.' };
  }
  const hb = resolveHeartbeatStatus(status.lastHeartbeatAt, nowMs);
  if (hb === 'offline') {
    return {
      ...base,
      status: 'offline',
      reason: `El puente BioStar no reporta desde el ${formatArShort(status.lastHeartbeatAt)}.`
    };
  }

  const successMs = toMillis(status.lastSuccessAt);
  const errorMs = toMillis(status.lastErrorAt);
  const cursorMs = toMillis(status.cursor);
  const errorIsNewer = Boolean(status.lastError)
    && errorMs != null
    && (successMs == null || errorMs > successMs);
  const successStale = successMs == null || (nowMs - successMs) > BIOSTAR_SUCCESS_STALE_MS;

  if (errorIsNewer || successStale) {
    const since = cursorMs ?? successMs;
    let reason = since != null
      ? `Sin importar huellas desde el ${formatArShort(since)}`
      : 'Sin importar huellas todavía';
    if (errorIsNewer) reason += ` — error: ${String(status.lastError).slice(0, 200)}`;
    return {
      ...base,
      status: 'degraded',
      reason,
      problemCode: errorIsNewer ? 'biostar_error' : 'biostar_sin_exito',
      problemSince: successMs ?? errorMs ?? toMillis(status.lastHeartbeatAt)
    };
  }

  const backlog = Number(status.backlogEstimate);
  let notice = null;
  if (Number.isFinite(backlog) && backlog > 0 && cursorMs != null
    && (nowMs - cursorMs) > BIOSTAR_SUCCESS_STALE_MS) {
    notice = `Poniéndose al día: historial completo hasta el ${formatArShort(cursorMs)} (quedan ${backlog} pases o más).`;
  }
  return { ...base, status: hb, notice };
};

/**
 * @param {{ problem?: { code: string, reason: string, since?: number|null } | null }} input
 */
const toBridgeRow = ({ kind, id, name, lastAt, enabled = true, problem = null, nowMs = Date.now() }) => {
  let status = resolveHeartbeatStatus(lastAt, nowMs);
  let reason = null;
  if (problem && status !== 'offline') {
    status = 'degraded';
    reason = problem.reason || null;
  }
  return {
    kind,
    id,
    name,
    lastAt: lastAt || null,
    enabled: enabled !== false,
    status,
    reason,
    problemCode: status === 'degraded' ? (problem.code || 'problema') : null,
    problemSince: status === 'degraded' ? (problem.since ?? null) : null,
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

/**
 * Qué aviso mandar para una fila, usando el mismo throttling que el de "sin señal".
 * @returns {'offline'|'problem'|'recovered'|null}
 */
const decideBridgeNotification = (row, prev = {}, nowMs = Date.now()) => {
  if (!row.enabled || !row.everSeen) return null;
  if (shouldAlertOffline(row, prev, nowMs)) return 'offline';
  if (row.status === 'degraded') {
    const since = row.problemSince != null ? Number(row.problemSince) : null;
    if (since != null && (nowMs - since) < PROBLEM_GRACE_MS) return null;
    // Sin "since" confiable: esperar a verlo en dos corridas seguidas.
    if (since == null && prev.lastStatus !== 'degraded') return null;
    const sameProblem = prev.alerted
      && prev.lastStatus === 'degraded'
      && prev.problemCode === row.problemCode;
    if (!sameProblem) return 'problem';
    const lastNotified = prev.lastNotifiedAt ? Number(prev.lastNotifiedAt) : 0;
    return !lastNotified || (nowMs - lastNotified) >= RENOTIFY_MS ? 'problem' : null;
  }
  if (row.status === 'online' && prev.alerted) return 'recovered';
  return null;
};

module.exports = {
  STATUS_GREEN_MS,
  STATUS_YELLOW_MS,
  RENOTIFY_MS,
  PROBLEM_GRACE_MS,
  BIOSTAR_SUCCESS_STALE_MS,
  toMillis,
  formatArShort,
  resolveHeartbeatStatus,
  evaluateBiostarHealth,
  toBridgeRow,
  shouldAlertOffline,
  decideBridgeNotification
};
