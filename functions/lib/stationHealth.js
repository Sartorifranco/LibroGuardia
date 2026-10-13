/**
 * Chequeos de salud que manda la estación en su heartbeat (lector serie, relé,
 * cola offline, login…). Se guardan en `lectores/{id}.checks` con la hora del
 * último cambio de cada uno, y los cambios importantes van a `deviceEvents`.
 *
 * Funciones puras salvo recordCheckTransitions.
 */

const { db, FieldValue } = require('../firestore');
const { resolveHeartbeatStatus, toMillis } = require('./bridgeHealthEvaluate');

/** Chequeos cuyos cambios se registran en deviceEvents (alimentan alertas). */
const TRANSITION_CHECKS = ['serialConnected', 'relayReachable', 'loginError'];

const toBoolOrUndefined = (value) => {
  if (value === true || value === false) return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return undefined;
};

const toIsoOrUndefined = (value) => {
  if (value === null || value === '') return null;
  if (value === undefined) return undefined;
  const ms = toMillis(value);
  return ms == null ? undefined : new Date(ms).toISOString();
};

/**
 * Valores reportados por la estación (los que no vienen quedan undefined = "no informado").
 * @returns {Record<string, any>}
 */
const sanitizeHeartbeatChecks = (body = {}, serverNowMs = Date.now()) => {
  const out = {};
  const serial = toBoolOrUndefined(body.serialConnected);
  if (serial !== undefined) out.serialConnected = serial;
  const relay = toBoolOrUndefined(body.relayReachable);
  if (relay !== undefined) out.relayReachable = relay;

  const queue = body.offlineQueueLength;
  if (queue !== undefined && queue !== null && queue !== '') {
    const n = Number(queue);
    if (Number.isFinite(n) && n >= 0) out.offlineQueueLength = Math.round(n);
  }

  const allowlistAt = toIsoOrUndefined(body.allowlistGeneratedAt);
  if (allowlistAt !== undefined) out.allowlistGeneratedAt = allowlistAt;

  if (body.loginError !== undefined) {
    out.loginError = body.loginError ? String(body.loginError).slice(0, 200) : null;
  }
  if (body.bridgeVersion) out.bridgeVersion = String(body.bridgeVersion).slice(0, 40);

  const clientMs = toMillis(body.clientTime ?? body.sentAt ?? null);
  if (clientMs != null) out.clockSkewMs = Math.round(clientMs - serverNowMs);

  return out;
};

const sameValue = (a, b) => (a ?? null) === (b ?? null);

/**
 * Mezcla lo reportado con lo guardado: `lastChangeAt` solo se mueve si cambió el valor.
 * @returns {{ checks: Record<string, {value:any,lastChangeAt:string}>, transitions: Array }}
 */
const mergeChecks = (prevChecks = {}, incoming = {}, nowIso = new Date().toISOString()) => {
  const prev = prevChecks && typeof prevChecks === 'object' ? prevChecks : {};
  const checks = {};
  const transitions = [];
  Object.entries(incoming).forEach(([key, value]) => {
    const before = prev[key];
    const hadBefore = before && typeof before === 'object' && 'value' in before;
    if (hadBefore && sameValue(before.value, value)) {
      checks[key] = { value, lastChangeAt: before.lastChangeAt || nowIso };
      return;
    }
    checks[key] = { value: value ?? null, lastChangeAt: nowIso };
    if (TRANSITION_CHECKS.includes(key) && (hadBefore || value === false || (key === 'loginError' && value))) {
      transitions.push({ check: key, from: hadBefore ? (before.value ?? null) : null, to: value ?? null });
    }
  });
  return { checks, transitions };
};

const checkValue = (checks, key) => {
  const entry = checks?.[key];
  if (entry && typeof entry === 'object' && 'value' in entry) return entry.value;
  return undefined;
};

const checkSince = (checks, key) => toMillis(checks?.[key]?.lastChangeAt) ?? null;

/**
 * Problemas activos de un lector según sus chequeos (más grave primero).
 * @returns {Array<{ code: string, reason: string, since: number|null }>}
 */
const listLectorProblems = (lector = {}) => {
  const checks = lector.checks || {};
  const problems = [];
  const loginError = checkValue(checks, 'loginError');
  if (loginError) {
    problems.push({
      code: 'credenciales',
      reason: `Credenciales inválidas en la estación (${String(loginError).slice(0, 80)})`,
      since: checkSince(checks, 'loginError')
    });
  }
  if (checkValue(checks, 'serialConnected') === false) {
    const port = lector.puertoDetectado || lector.serialPort || '';
    problems.push({
      code: 'lector_desconectado',
      reason: port ? `Lector no conectado (${port})` : 'Lector no conectado',
      since: checkSince(checks, 'serialConnected')
    });
  }
  if (checkValue(checks, 'relayReachable') === false) {
    problems.push({
      code: 'rele_no_responde',
      reason: 'Placa de relé no responde',
      since: checkSince(checks, 'relayReachable')
    });
  }
  return problems;
};

const SIN_SENAL = {
  stale: 'Sin señal reciente de la estación',
  offline: 'Sin señal de la estación'
};

/**
 * Estado para la UI: 'online' solo si el heartbeat está fresco y no hay problemas.
 * @returns {{ connectionStatus: 'online'|'problem'|'stale'|'offline', reason: string|null,
 *   problemCode: string|null, problemSince: number|null }}
 */
const resolveLectorHealth = (lector = {}, nowMs = Date.now()) => {
  const hb = resolveHeartbeatStatus(lector.ultimaConexion, nowMs);
  if (hb === 'offline') {
    return {
      connectionStatus: 'offline',
      reason: lector.ultimaConexion ? SIN_SENAL.offline : 'Nunca se conectó',
      problemCode: null,
      problemSince: null
    };
  }
  const problems = listLectorProblems(lector);
  if (problems.length) {
    return {
      connectionStatus: 'problem',
      reason: problems.map((p) => p.reason).join(' · '),
      problemCode: problems[0].code,
      problemSince: problems[0].since
    };
  }
  return {
    connectionStatus: hb,
    reason: hb === 'stale' ? SIN_SENAL.stale : null,
    problemCode: null,
    problemSince: null
  };
};

/** Lector → payload público {status, reason} (sin datos internos). */
const toHealthPayload = (health) => ({
  status: health.connectionStatus,
  reason: health.reason || null
});

/**
 * Estación: su propio heartbeat + el peor estado de sus lectores.
 */
const resolveEstacionHealth = (estacion = {}, lectores = [], nowMs = Date.now()) => {
  const hb = resolveHeartbeatStatus(estacion.ultimaConexion, nowMs);
  if (hb === 'offline') {
    return {
      connectionStatus: 'offline',
      reason: estacion.ultimaConexion ? SIN_SENAL.offline : 'Nunca se conectó'
    };
  }
  const reasons = [];
  lectores.forEach((l) => {
    const h = resolveLectorHealth(l, nowMs);
    if (h.connectionStatus === 'problem' || h.connectionStatus === 'offline') {
      reasons.push(`${l.nombre || l.readerId || l.id}: ${h.reason}`);
    }
  });
  if (reasons.length) {
    return { connectionStatus: 'problem', reason: reasons.join(' · ') };
  }
  return { connectionStatus: hb, reason: hb === 'stale' ? SIN_SENAL.stale : null };
};

/**
 * Peor salud entre los lectores de cada puerta (para /guard/doors).
 * @returns {Map<string, {status, reason}>}
 */
const RANK = { offline: 3, problem: 2, stale: 1, online: 0 };
const buildDoorHealthMap = (lectores = [], nowMs = Date.now()) => {
  const byDoor = new Map();
  lectores.forEach((l) => {
    const doorId = String(l.doorId || '').trim();
    if (!doorId) return;
    const h = resolveLectorHealth(l, nowMs);
    const current = byDoor.get(doorId);
    if (!current || RANK[h.connectionStatus] > RANK[current.status]) {
      byDoor.set(doorId, toHealthPayload(h));
    }
  });
  return byDoor;
};

const describeTransition = (t) => {
  if (t.check === 'serialConnected') return t.to === false ? 'lector_desconectado' : 'lector_conectado';
  if (t.check === 'relayReachable') return t.to === false ? 'rele_no_responde' : 'rele_responde';
  if (t.check === 'loginError') return t.to ? 'login_error' : 'login_ok';
  return t.check;
};

/** Registra cambios de chequeos en deviceEvents (best-effort, no rompe el heartbeat). */
const recordCheckTransitions = async ({ lectorId, doorId, readerId, transitions = [] } = {}) => {
  if (!transitions.length) return 0;
  try {
    const batch = db.batch();
    transitions.forEach((t) => {
      batch.set(db.collection('deviceEvents').doc(), {
        source: 'estacion',
        lectorId: lectorId || null,
        deviceId: lectorId || null,
        doorId: doorId || null,
        readerId: readerId || null,
        code: describeTransition(t),
        check: t.check,
        from: t.from ?? null,
        to: t.to ?? null,
        at: FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    return transitions.length;
  } catch (err) {
    console.warn('[stationHealth] No se pudieron registrar transiciones', err.message);
    return 0;
  }
};

module.exports = {
  TRANSITION_CHECKS,
  sanitizeHeartbeatChecks,
  mergeChecks,
  listLectorProblems,
  resolveLectorHealth,
  resolveEstacionHealth,
  buildDoorHealthMap,
  toHealthPayload,
  recordCheckTransitions
};
