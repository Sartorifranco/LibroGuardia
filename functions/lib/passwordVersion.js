/**
 * Versión de contraseña para invalidar JWTs al reset/cambio.
 * Cache en memoria (TTL corto) + invalidación inmediata al mutar password.
 * El mismo cache guarda si el usuario está activo, así el middleware `auth`
 * rechaza usuarios desactivados sin sumar lecturas a Firestore por request.
 */

const CACHE_TTL_MS = 60 * 1000;
const versionCache = new Map();

const SESSION_PASSWORD_CHANGED_MESSAGE =
  'Tu sesión expiró porque la contraseña fue actualizada, iniciá sesión de nuevo';

const USER_INACTIVE_MESSAGE =
  'Su cuenta ha sido deshabilitada. Contacte a un administrador.';

const isUserActive = (userData = {}) => userData.active !== false;

const getPasswordVersion = (userData = {}) => {
  const n = Number(userData.passwordVersion);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
};

const nextPasswordVersion = (userData = {}) => getPasswordVersion(userData) + 1;

const getCachedEntry = (userId) => {
  const key = String(userId || '');
  if (!key) return null;
  const entry = versionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > CACHE_TTL_MS) {
    versionCache.delete(key);
    return null;
  }
  return entry;
};

const getCachedPasswordVersion = (userId) => {
  const entry = getCachedEntry(userId);
  return entry ? entry.version : null;
};

const getCachedUserAuthState = (userId) => {
  const entry = getCachedEntry(userId);
  return entry ? { version: entry.version, active: entry.active !== false } : null;
};

/**
 * @param {string} userId
 * @param {number} version
 * @param {boolean} [active] si se omite, conserva el estado cacheado previo (o true).
 */
const setCachedPasswordVersion = (userId, version, active) => {
  const key = String(userId || '');
  if (!key) return;
  const prev = versionCache.get(key);
  const resolvedActive = typeof active === 'boolean'
    ? active
    : (prev ? prev.active !== false : true);
  versionCache.set(key, {
    version: getPasswordVersion({ passwordVersion: version }),
    active: resolvedActive,
    loadedAt: Date.now()
  });
};

/** Cachea versión + estado activo a partir del doc del usuario ya leído. */
const cacheUserAuthState = (userId, userData = {}) => {
  setCachedPasswordVersion(userId, getPasswordVersion(userData), isUserActive(userData));
};

const invalidatePasswordVersionCache = (userId) => {
  const key = String(userId || '');
  if (key) versionCache.delete(key);
};

/**
 * Resuelve versión + estado activo (cache → Firestore).
 * @returns {Promise<{version:number, active:boolean}|null>} null si el usuario no existe
 */
const resolveUserAuthState = async (db, userId) => {
  const cached = getCachedUserAuthState(userId);
  if (cached) return cached;

  const snap = await db.collection('users').doc(String(userId)).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  cacheUserAuthState(userId, data);
  return { version: getPasswordVersion(data), active: isUserActive(data) };
};

/**
 * Resuelve la versión actual (cache → Firestore).
 * @returns {Promise<number|null>} null si el usuario no existe
 */
const resolvePasswordVersion = async (db, userId) => {
  const state = await resolveUserAuthState(db, userId);
  return state ? state.version : null;
};

const assertTokenPasswordVersion = async (db, tokenPayload = {}) => {
  const userId = tokenPayload.id;
  if (!userId) {
    const err = new Error('Token no válido');
    err.status = 401;
    throw err;
  }

  const state = await resolveUserAuthState(db, userId);
  if (!state) {
    const err = new Error('Token no válido');
    err.status = 401;
    throw err;
  }

  // Usuario desactivado: se rechaza para todos los roles (admin incluido).
  if (state.active === false) {
    const err = new Error(USER_INACTIVE_MESSAGE);
    err.status = 401;
    err.code = 'USER_INACTIVE';
    throw err;
  }

  const tokenVersion = getPasswordVersion({
    passwordVersion: tokenPayload.passwordVersion
  });

  if (tokenVersion !== state.version) {
    const err = new Error(SESSION_PASSWORD_CHANGED_MESSAGE);
    err.status = 401;
    err.code = 'PASSWORD_VERSION_MISMATCH';
    throw err;
  }

  return state.version;
};

/** Solo tests. */
const _clearPasswordVersionCacheForTests = () => {
  versionCache.clear();
};

module.exports = {
  CACHE_TTL_MS,
  SESSION_PASSWORD_CHANGED_MESSAGE,
  USER_INACTIVE_MESSAGE,
  isUserActive,
  getPasswordVersion,
  nextPasswordVersion,
  getCachedPasswordVersion,
  getCachedUserAuthState,
  setCachedPasswordVersion,
  cacheUserAuthState,
  invalidatePasswordVersionCache,
  resolveUserAuthState,
  resolvePasswordVersion,
  assertTokenPasswordVersion,
  _clearPasswordVersionCacheForTests
};
