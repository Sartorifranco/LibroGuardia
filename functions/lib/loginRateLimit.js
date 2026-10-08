/**
 * Rate limiting de login por usuario (bloqueo fuerte).
 * La IP NO bloquea el acceso: solo se usa como señal de alerta
 * cuando una misma IP prueba muchas cuentas distintas.
 *
 * Cuentas técnicas (lectores/estaciones: usuario kiosk.* o rol kiosk_puerta):
 * el bloqueo es por usuario + IP. Un equipo viejo en otra red con la clave
 * anterior no debe dejar afuera a la estación legítima (las claves técnicas son
 * de 24 caracteres aleatorios: fuerza bruta inviable). Si fallan desde una IP
 * distinta a la del último login correcto se registra una alerta en deviceAlerts.
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
const userIpDocId = (username, ip) => `userip_${sanitizeKeyPart(username)}__${sanitizeKeyPart(ip)}`;
const technicalDocId = (username) => `tech_${sanitizeKeyPart(username)}`;

const TECHNICAL_USERNAME_PREFIX = 'kiosk.';
const TECHNICAL_ROLE_IDS = ['kiosk_puerta'];
const DEVICE_ALERTS_COLLECTION = 'deviceAlerts';

/** Cuenta técnica de lector/estación (no humana). */
const isTechnicalAccount = ({ username = '', role = '' } = {}) => (
  String(username || '').trim().toLowerCase().startsWith(TECHNICAL_USERNAME_PREFIX)
  || TECHNICAL_ROLE_IDS.includes(String(role || '').trim())
);

const resolveTechnical = ({ username, technical } = {}) => (
  typeof technical === 'boolean' ? technical : isTechnicalAccount({ username })
);

/** Doc de bloqueo: por usuario (humanos) o por usuario+IP (técnicas). */
const limitDocIdFor = ({ username, ip, technical } = {}) => (
  resolveTechnical({ username, technical })
    ? userIpDocId(username, ip || 'unknown')
    : userDocId(username)
);

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

/** Bloquea por usuario (o usuario+IP en cuentas técnicas); la IP sola nunca cierra el login. */
const checkLoginRateLimit = async (db, { username, ip = null, technical } = {}, now = Date.now()) => {
  const userData = await readLimitDoc(db, limitDocIdFor({ username, ip, technical }));
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
const writeUserFailure = async (db, FieldValue, { username, ip, technical }, now) => runLimitTransaction(
  db,
  db.collection(COLLECTION).doc(limitDocIdFor({ username, ip, technical })),
  (data) => {
    const next = nextFailureState(data, now);
    const isTech = resolveTechnical({ username, technical });
    return {
      write: {
        ...(isTech ? { kind: 'user_ip', username: sanitizeKeyPart(username), ip: ip || 'unknown' } : {}),
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

/**
 * Cuenta técnica que falla desde una IP distinta a la del último login correcto:
 * casi siempre un equipo viejo con credenciales anteriores. Alerta visible en
 * deviceAlerts (un doc por usuario+IP, con contador).
 */
const recordTechnicalFailureAlert = async (db, FieldValue, { username, ip }, now = Date.now()) => {
  const tech = await readLimitDoc(db, technicalDocId(username));
  const lastSuccessIp = tech?.lastSuccessIp || null;
  if (!lastSuccessIp || !ip || lastSuccessIp === ip) return { alert: false };
  const user = sanitizeKeyPart(username);
  const alertId = `credenciales_viejas__${user}__${sanitizeKeyPart(ip)}`;
  await db.collection(DEVICE_ALERTS_COLLECTION).doc(alertId).set({
    kind: 'credenciales_viejas',
    username: user,
    ip,
    lastSuccessIp,
    at: now,
    count: FieldValue.increment(1),
    resolved: false,
    message: `La cuenta técnica ${user} falla el login desde ${ip} (último login correcto desde ${lastSuccessIp}). Probablemente un equipo viejo con la clave anterior.`,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  console.warn('[loginRateLimit] Cuenta técnica con credenciales viejas', { username: user, ip, lastSuccessIp });
  return { alert: true, alertId };
};

const recordFailedLogin = async (db, FieldValue, { username, ip, technical }, now = Date.now()) => {
  const isTech = resolveTechnical({ username, technical });
  const userNext = await writeUserFailure(db, FieldValue, { username, ip, technical: isTech }, now);

  if (isTech) {
    await recordTechnicalFailureAlert(db, FieldValue, { username, ip }, now).catch((err) => {
      console.warn('[loginRateLimit] No se pudo registrar alerta de cuenta técnica', err.message);
    });
  }

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

/**
 * Limpia fallos. Humanos: doc por usuario. Técnicas: con ip, el doc de esa IP;
 * sin ip (destrabe desde Admin), todos los docs usuario+IP de la cuenta.
 */
const clearLoginFailures = async (db, { username, ip = null, technical } = {}) => {
  await db.collection(COLLECTION).doc(userDocId(username)).delete().catch(() => {});
  if (!resolveTechnical({ username, technical })) return;
  if (ip) {
    await db.collection(COLLECTION).doc(userIpDocId(username, ip)).delete().catch(() => {});
    return;
  }
  try {
    const snap = await db.collection(COLLECTION)
      .where('username', '==', sanitizeKeyPart(username))
      .limit(100)
      .get();
    await Promise.all(snap.docs
      .filter((doc) => doc.id.startsWith('userip_'))
      .map((doc) => doc.ref.delete().catch(() => {})));
  } catch (err) {
    console.warn('[loginRateLimit] No se pudieron limpiar bloqueos por IP', err.message);
  }
};

/** Login correcto de cuenta técnica: recuerda la IP para detectar equipos viejos. */
const recordSuccessfulLogin = async (db, FieldValue, { username, ip, technical } = {}, now = Date.now()) => {
  if (!resolveTechnical({ username, technical }) || !ip) return;
  await db.collection(COLLECTION).doc(technicalDocId(username)).set({
    kind: 'technical_last_success',
    username: sanitizeKeyPart(username),
    lastSuccessIp: ip,
    lastSuccessAt: now,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
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
  DEVICE_ALERTS_COLLECTION,
  getClientIp,
  userDocId,
  ipDocId,
  userIpDocId,
  technicalDocId,
  isTechnicalAccount,
  limitDocIdFor,
  pairingIpDocId,
  evaluateRateLimitState,
  nextFailureState,
  checkLoginRateLimit,
  recordFailedLogin,
  clearLoginFailures,
  recordSuccessfulLogin,
  recordTechnicalFailureAlert,
  recordIpProbe,
  checkPairingRateLimit,
  recordPairingFailure
};
