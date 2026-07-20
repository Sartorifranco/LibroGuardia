/**
 * Versión de contraseña para invalidar JWTs al reset/cambio.
 * Cache en memoria (TTL corto) + invalidación inmediata al mutar password.
 */

const CACHE_TTL_MS = 60 * 1000;
const versionCache = new Map();

const SESSION_PASSWORD_CHANGED_MESSAGE =
  'Tu sesión expiró porque la contraseña fue actualizada, iniciá sesión de nuevo';

const getPasswordVersion = (userData = {}) => {
  const n = Number(userData.passwordVersion);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
};

const nextPasswordVersion = (userData = {}) => getPasswordVersion(userData) + 1;

const getCachedPasswordVersion = (userId) => {
  const key = String(userId || '');
  if (!key) return null;
  const entry = versionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > CACHE_TTL_MS) {
    versionCache.delete(key);
    return null;
  }
  return entry.version;
};

const setCachedPasswordVersion = (userId, version) => {
  const key = String(userId || '');
  if (!key) return;
  versionCache.set(key, {
    version: getPasswordVersion({ passwordVersion: version }),
    loadedAt: Date.now()
  });
};

const invalidatePasswordVersionCache = (userId) => {
  const key = String(userId || '');
  if (key) versionCache.delete(key);
};

/**
 * Resuelve la versión actual (cache → Firestore).
 * @returns {Promise<number|null>} null si el usuario no existe
 */
const resolvePasswordVersion = async (db, userId) => {
  const cached = getCachedPasswordVersion(userId);
  if (cached != null) return cached;

  const snap = await db.collection('users').doc(String(userId)).get();
  if (!snap.exists) return null;
  const version = getPasswordVersion(snap.data());
  setCachedPasswordVersion(userId, version);
  return version;
};

const assertTokenPasswordVersion = async (db, tokenPayload = {}) => {
  const userId = tokenPayload.id;
  if (!userId) {
    const err = new Error('Token no válido');
    err.status = 401;
    throw err;
  }

  const currentVersion = await resolvePasswordVersion(db, userId);
  if (currentVersion == null) {
    const err = new Error('Token no válido');
    err.status = 401;
    throw err;
  }

  const tokenVersion = getPasswordVersion({
    passwordVersion: tokenPayload.passwordVersion
  });

  if (tokenVersion !== currentVersion) {
    const err = new Error(SESSION_PASSWORD_CHANGED_MESSAGE);
    err.status = 401;
    err.code = 'PASSWORD_VERSION_MISMATCH';
    throw err;
  }

  return currentVersion;
};

/** Solo tests. */
const _clearPasswordVersionCacheForTests = () => {
  versionCache.clear();
};

module.exports = {
  CACHE_TTL_MS,
  SESSION_PASSWORD_CHANGED_MESSAGE,
  getPasswordVersion,
  nextPasswordVersion,
  getCachedPasswordVersion,
  setCachedPasswordVersion,
  invalidatePasswordVersionCache,
  resolvePasswordVersion,
  assertTokenPasswordVersion,
  _clearPasswordVersionCacheForTests
};
