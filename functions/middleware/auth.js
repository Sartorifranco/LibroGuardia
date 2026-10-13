/**
 * Middleware y helpers HTTP compartidos por los routers de functions/routes/.
 * Extraído de app.js sin cambiar comportamiento.
 */

const jwt = require('jsonwebtoken');
const { db } = require('../firestore');
const { resolvePermissions } = require('../permissions');
const { getRoleTemplatesFromFirestore } = require('../roles');
const {
  USER_INACTIVE_MESSAGE,
  isUserActive,
  assertTokenPasswordVersion,
  cacheUserAuthState
} = require('../lib/passwordVersion');

const JWT_ALGORITHM = 'HS256';
const MIN_JWT_SECRET_LENGTH = 32;
const DEFAULT_TOKEN_TTL = '8h';
const GENERIC_SERVER_ERROR = 'Error interno del servidor';

const jwtConfigError = (detail) => {
  const err = new Error(`JWT_SECRET inválida: ${detail}`);
  err.code = 'JWT_SECRET_INVALID';
  err.status = 500;
  return err;
};

/**
 * Devuelve el secreto JWT o lanza si falta / es demasiado corto.
 * Nunca se firma ni verifica con un secreto débil.
 */
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('[auth] JWT_SECRET no configurada: se rechaza firmar/verificar tokens.');
    throw jwtConfigError('no configurada');
  }
  if (String(secret).length < MIN_JWT_SECRET_LENGTH) {
    console.error(`[auth] JWT_SECRET demasiado corta (mínimo ${MIN_JWT_SECRET_LENGTH} caracteres): se rechaza firmar/verificar tokens.`);
    throw jwtConfigError('demasiado corta');
  }
  return secret;
};

const signAuthToken = (payload, { expiresIn = DEFAULT_TOKEN_TTL } = {}) => (
  jwt.sign(payload, getJwtSecret(), { algorithm: JWT_ALGORITHM, expiresIn })
);

const verifyAuthToken = (token, secret = getJwtSecret()) => (
  jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] })
);

/**
 * 500 genérico: el detalle queda en el log del servidor, no en la respuesta.
 */
const sendServerError = (res, err, message = GENERIC_SERVER_ERROR, context = '') => {
  console.error(`[api] ${context || message}:`, err?.stack || err?.message || err);
  return res.status(500).json({ message });
};

/**
 * Errores con status explícito < 500 (validación/negocio) exponen su mensaje;
 * el resto se trata como 500 genérico.
 */
const sendRouteError = (res, err, fallbackMessage = GENERIC_SERVER_ERROR, extra = {}) => {
  const status = Number(err?.status) || 500;
  if (status < 500) {
    return res.status(status).json({ message: err.message || fallbackMessage, ...extra, ...(err.code ? { code: err.code } : {}) });
  }
  return sendServerError(res, err, fallbackMessage);
};

const getRoleTemplates = async () => getRoleTemplatesFromFirestore();

const getUserPermissions = async (userData) => {
  const roleTemplates = await getRoleTemplates();
  return resolvePermissions(userData.role, userData.permissions || [], roleTemplates);
};

const userToJSON = (doc, permissions = null) => {
  const data = doc.data();
  return {
    id: doc.id,
    username: data.username,
    role: data.role,
    active: data.active !== false,
    mustChangePassword: data.mustChangePassword === true,
    permissions: permissions || data.permissions || [],
    customPermissions: data.permissions || [],
    empresaId: data.empresaId || null,
    nombre: data.nombre || null,
    email: data.email || null,
    emailVerified: data.emailVerified !== false,
    puesto: data.puesto || null,
    lastLoginAt: data.lastLoginAt || null
  };
};

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ message: 'No token, autorización denegada' });
  }

  let secret;
  try {
    secret = getJwtSecret();
  } catch (_err) {
    return res.status(500).json({ message: 'Error de configuración del servidor' });
  }

  try {
    const payload = verifyAuthToken(token, secret);
    // Rechaza tokens viejos (passwordVersion) y usuarios desactivados (todos los roles).
    await assertTokenPasswordVersion(db, payload);
    req.user = payload;
    next();
  } catch (err) {
    const message = err.status === 401 && err.message
      ? err.message
      : 'Token no válido';
    res.status(401).json({ message, ...(err.code === 'USER_INACTIVE' ? { code: err.code } : {}) });
  }
};

const authorize = (roles = []) => {
  if (typeof roles === 'string') roles = [roles];
  return (req, res, next) => {
    if (!req.user || (roles.length && !roles.includes(req.user.role))) {
      return res.status(403).json({ message: 'Acceso denegado: No tiene los permisos necesarios' });
    }
    next();
  };
};

/**
 * Lee el doc del usuario, refresca el cache de auth y resuelve permisos.
 * @returns {Promise<{status:number, message:string}|{permissions:string[]}>}
 */
const loadUserPermissions = async (userId) => {
  const snap = await db.collection('users').doc(String(userId)).get();
  if (!snap.exists) {
    return { status: 404, message: 'Usuario no encontrado' };
  }
  const data = snap.data() || {};
  // Reutiliza la lectura para refrescar el cache de passwordVersion / active.
  cacheUserAuthState(userId, data);
  if (!isUserActive(data)) {
    return { status: 401, message: USER_INACTIVE_MESSAGE, code: 'USER_INACTIVE' };
  }
  return { permissions: await getUserPermissions(data) };
};

const requirePermission = (permission) => async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'No token, autorización denegada' });
    }
    if (req.user.role === 'admin') return next();

    const loaded = await loadUserPermissions(req.user.id);
    if (!loaded.permissions) {
      return res.status(loaded.status).json({ message: loaded.message, ...(loaded.code ? { code: loaded.code } : {}) });
    }
    if (!loaded.permissions.includes(permission)) {
      return res.status(403).json({ message: 'Acceso denegado: permiso insuficiente' });
    }
    req.userPermissions = loaded.permissions;
    next();
  } catch (err) {
    sendServerError(res, err, 'Error al validar permisos');
  }
};

const requireAnyPermission = (permissionList = []) => async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'No token, autorización denegada' });
    }
    if (req.user.role === 'admin') {
      // Admin: scopes se resuelven por role; no usamos permisos del JWT.
      req.userPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      return next();
    }

    const loaded = await loadUserPermissions(req.user.id);
    if (!loaded.permissions) {
      return res.status(loaded.status).json({ message: loaded.message, ...(loaded.code ? { code: loaded.code } : {}) });
    }
    const allowed = permissionList.some((permission) => loaded.permissions.includes(permission));
    if (!allowed) {
      return res.status(403).json({ message: 'Acceso denegado: permiso insuficiente' });
    }
    // Permisos resueltos desde Firestore (no confiar en el claim del JWT).
    req.userPermissions = loaded.permissions;
    next();
  } catch (err) {
    sendServerError(res, err, 'Error al validar permisos');
  }
};

/**
 * true si el usuario autenticado tiene alguno de los permisos (admin: siempre).
 * Usa req.userPermissions si un middleware previo ya los resolvió desde Firestore;
 * si no, los resuelve (nunca confía en el claim `permissions` del JWT).
 */
const userHasAnyPermission = async (req, permissionList = []) => {
  if (!req?.user) return false;
  if (req.user.role === 'admin') return true;
  let permissions = Array.isArray(req.userPermissions) ? req.userPermissions : null;
  if (!permissions) {
    const loaded = await loadUserPermissions(req.user.id);
    permissions = loaded.permissions || [];
    req.userPermissions = permissions;
  }
  return permissionList.some((permission) => permissions.includes(permission));
};

module.exports = {
  JWT_ALGORITHM,
  MIN_JWT_SECRET_LENGTH,
  GENERIC_SERVER_ERROR,
  getJwtSecret,
  signAuthToken,
  verifyAuthToken,
  sendServerError,
  sendRouteError,
  getRoleTemplates,
  getUserPermissions,
  userToJSON,
  auth,
  authorize,
  requirePermission,
  requireAnyPermission,
  userHasAnyPermission
};
