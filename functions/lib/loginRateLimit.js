/**
 * Rate limiting de login por usuario (bloqueo fuerte).
 * La IP NO bloquea el acceso: solo se usa como señal de alerta
 * cuando una misma IP prueba muchas cuentas distintas.
 */

const COLLECTION = 'loginRateLimits';
const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
/** Umbral de alerta (no bloqueo) por IP: muchas cuentas distintas. */
const IP_ALERT_DISTINCT_USERS = 8;
const LOCKOUT_MESSAGE = 'Demasiados intentos fallidos. Probá de nuevo en unos minutos.';

const toMillis = (value) => {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return null;
};

const sanitizeKeyPart = (value) => String(value || 'unknown')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9._:-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 120) || 'unknown';

const userDocId = (username) => `user_${sanitizeKeyPart(username)}`;
const ipDocId = (ip) => `ip_${sanitizeKeyPart(ip)}`;

/**
 * IP del cliente según Express (`req.ip`), que respeta `trust proxy` (ver app.js).
 * No se lee X-Forwarded-For a mano: su primer valor lo controla el cliente
 * y permitiría saltear el rate limit por IP.
 */
const getClientIp = (req) => (
  req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown'
);

/**
 * Read-modify-write atómico de un doc de rate limit (transacción Firestore).
 * `compute(data)` devuelve { write, result }: `write` se guarda con merge.
 */
const runLimitTransaction = async (db, docRef, compute) => db.runTransaction(async (tx) => {
  const snap = await tx.get(docRef);
  const data = snap.exists ? snap.data() : null;
  const { write, result } = compute(data);
  tx.set(docRef, write, { merge: true });
  return result;
});

/**
 * Evalúa el estado de un documento de rate limit (pura, testeable).
 */
const evaluateRateLimitState = (data = null, now = Date.now()) => {
  const blockedUntil = toMillis(data?.blockedUntil);
  if (blockedUntil && blockedUntil > now) {
    return {
      blocked: true,
      failedAttempts: Number(data.failedAttempts) || 0,
      windowExpired: false,
      blockedUntil
    };
  }

  const windowStartedAt = toMillis(data?.windowStartedAt);
  if (!windowStartedAt || (now - windowStartedAt) > WINDOW_MS) {
    return {
      blocked: false,
      failedAttempts: 0,
      windowExpired: true,
      blockedUntil: null
    };
  }

  return {
    blocked: false,
    failedAttempts: Number(data.failedAttempts) || 0,
    windowExpired: false,
    blockedUntil: null
  };
};

const nextFailureState = (data = null, now = Date.now()) => {
  const current = evaluateRateLimitState(data, now);
  if (current.blocked) {
    return {
      failedAttempts: current.failedAttempts,
      windowStartedAt: toMillis(data?.windowStartedAt) || now,
      blockedUntil: current.blockedUntil,
      justBlocked: false
    };
  }

  const failedAttempts = current.windowExpired ? 1 : current.failedAttempts + 1;
  const windowStartedAt = current.windowExpired ? now : (toMillis(data?.windowStartedAt) || now);
  const justBlocked = failedAttempts >= MAX_FAILED_ATTEMPTS;
  return {
    failedAttempts,
    windowStartedAt,
    blockedUntil: justBlocked ? now + BLOCK_MS : null,
    justBlocked
  };
};

const readLimitDoc = async (db, docId) => {
  const snap = await db.collection(COLLECTION).doc(docId).get();
  return snap.exists ? snap.data() : null;
};

/** Solo bloquea por usuario; la IP nunca cierra el login. */
const checkLoginRateLimit = async (db, { username }, now = Date.now()) => {
  const userData = await readLimitDoc(db, userDocId(username));
  const userState = evaluateRateLimitState(userData, now);

  if (!userState.blocked) {
    return { blocked: false };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((userState.blockedUntil - now) / 1000));
  return {
    blocked: true,
    message: LOCKOUT_MESSAGE,
    retryAfterSeconds
  };
};

/** Incrementa fallos del usuario en transacción (intentos concurrentes no se pisan). */
const writeUserFailure = async (db, FieldValue, username, now) => runLimitTransaction(
  db,
  db.collection(COLLECTION).doc(userDocId(username)),
  (data) => {
    const next = nextFailureState(data, now);
    return {
      write: {
        failedAttempts: next.failedAttempts,
        windowStartedAt: next.windowStartedAt,
        blockedUntil: next.blockedUntil,
        updatedAt: FieldValue.serverTimestamp()
      },
      result: next
    };
  }
);

/**
 * Registra actividad sospechosa por IP (cuentas distintas) sin bloquear.
 * @returns {{ alert: boolean, distinctUsers: number }}
 */
const recordIpProbe = async (db, FieldValue, { username, ip }, now = Date.now()) => {
  const docRef = db.collection(COLLECTION).doc(ipDocId(ip));
  const normalizedUser = sanitizeKeyPart(username);
  const { alert, attemptedUsers } = await runLimitTransaction(db, docRef, (data) => {
    const windowStartedAt = toMillis(data?.windowStartedAt);
    const windowExpired = !windowStartedAt || (now - windowStartedAt) > WINDOW_MS;

    let users = Array.isArray(data?.attemptedUsers) ? [...data.attemptedUsers] : [];
    if (windowExpired) {
      users = [];
    }
    if (!users.includes(normalizedUser)) {
      users.push(normalizedUser);
    }
    // Mantener lista acotada
    if (users.length > 50) {
      users = users.slice(-50);
    }

    const isAlert = users.length >= IP_ALERT_DISTINCT_USERS;
    return {
      write: {
        kind: 'ip_probe',
        attemptedUsers: users,
        distinctUsers: users.length,
        windowStartedAt: windowExpired ? now : (windowStartedAt || now),
        alertActive: isAlert,
        lastUsername: normalizedUser,
        updatedAt: FieldValue.serverTimestamp()
      },
      result: { alert: isAlert, attemptedUsers: users }
    };
  });

  if (alert) {
    console.warn('[loginRateLimit] Posible sniffing de login', {
      ip,
      distinctUsers: attemptedUsers.length,
      lastUsername: normalizedUser
    });
  }

  return { alert, distinctUsers: attemptedUsers.length };
};

const recordFailedLogin = async (db, FieldValue, { username, ip }, now = Date.now()) => {
  const userNext = await writeUserFailure(db, FieldValue, username, now);

  // Señal adicional: no bloquea a otros usuarios de la misma IP
  if (ip) {
    await recordIpProbe(db, FieldValue, { username, ip }, now).catch((err) => {
      console.warn('[loginRateLimit] No se pudo registrar sonda IP', err.message);
    });
  }

  if (userNext.justBlocked || (userNext.blockedUntil && userNext.blockedUntil > now)) {
    return {
      blocked: true,
      message: LOCKOUT_MESSAGE,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((Math.max(userNext.blockedUntil || 0, now + 1) - now) / 1000)
      )
    };
  }

  return { blocked: false };
};

const clearLoginFailures = async (db, { username }) => {
  await db.collection(COLLECTION).doc(userDocId(username)).delete().catch(() => {});
};

/** Rate limit del canje de pairing (por IP): mismo criterio de ventana/bloqueo que login. */
const pairingIpDocId = (ip) => `pairing_ip_${sanitizeKeyPart(ip)}`;

const checkPairingRateLimit = async (db, { ip }, now = Date.now()) => {
  const data = await readLimitDoc(db, pairingIpDocId(ip));
  const state = evaluateRateLimitState(data, now);
  if (!state.blocked) return { blocked: false };
  return {
    blocked: true,
    message: LOCKOUT_MESSAGE,
    retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000))
  };
};

const recordPairingFailure = async (db, FieldValue, { ip }, now = Date.now()) => {
  const docRef = db.collection(COLLECTION).doc(pairingIpDocId(ip));
  const next = await runLimitTransaction(db, docRef, (data) => {
    const state = nextFailureState(data, now);
    return {
      write: {
        kind: 'pairing',
        failedAttempts: state.failedAttempts,
        windowStartedAt: state.windowStartedAt,
        blockedUntil: state.blockedUntil,
        updatedAt: FieldValue.serverTimestamp()
      },
      result: state
    };
  });
  if (next.justBlocked || (next.blockedUntil && next.blockedUntil > now)) {
    return {
      blocked: true,
      message: LOCKOUT_MESSAGE,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((Math.max(next.blockedUntil || 0, now + 1) - now) / 1000)
      )
    };
  }
  return { blocked: false };
};

module.exports = {
  COLLECTION,
  MAX_FAILED_ATTEMPTS,
  WINDOW_MS,
  BLOCK_MS,
  IP_ALERT_DISTINCT_USERS,
  LOCKOUT_MESSAGE,
  getClientIp,
  userDocId,
  ipDocId,
  pairingIpDocId,
  evaluateRateLimitState,
  nextFailureState,
  checkLoginRateLimit,
  recordFailedLogin,
  clearLoginFailures,
  recordIpProbe,
  checkPairingRateLimit,
  recordPairingFailure
};
