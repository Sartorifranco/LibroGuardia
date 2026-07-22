/**
 * Middleware y helpers HTTP compartidos por los routers de functions/routes/.
 * Extraído de app.js sin cambiar comportamiento.
 */

const jwt = require('jsonwebtoken');
const { db } = require('../firestore');
const { resolvePermissions } = require('../permissions');
const { getRoleTemplatesFromFirestore } = require('../roles');
const {
  getPasswordVersion,
  assertTokenPasswordVersion,
  setCachedPasswordVersion
} = require('../lib/passwordVersion');

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no configurada');
  return secret;
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
    email: data.email || null
  };
};

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ message: 'No token, autorización denegada' });
  }
  try {
    const payload = jwt.verify(token, getJwtSecret());
    await assertTokenPasswordVersion(db, payload);
    req.user = payload;
    next();
  } catch (err) {
    const message = err.status === 401 && err.message
      ? err.message
      : 'Token no válido';
    res.status(401).json({ message });
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

const requirePermission = (permission) => async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'No token, autorización denegada' });
    }
    if (req.user.role === 'admin') return next();

    const snap = await db.collection('users').doc(req.user.id).get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    // Reutiliza la lectura para refrescar el cache de passwordVersion.
    setCachedPasswordVersion(req.user.id, getPasswordVersion(snap.data()));

    const permissions = await getUserPermissions(snap.data());
    if (!permissions.includes(permission)) {
      return res.status(403).json({ message: 'Acceso denegado: permiso insuficiente' });
    }
    req.userPermissions = permissions;
    next();
  } catch (err) {
    res.status(500).json({ message: 'Error al validar permisos', error: err.message });
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

    const snap = await db.collection('users').doc(req.user.id).get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    setCachedPasswordVersion(req.user.id, getPasswordVersion(snap.data()));

    const permissions = await getUserPermissions(snap.data());
    const allowed = permissionList.some((permission) => permissions.includes(permission));
    if (!allowed) {
      return res.status(403).json({ message: 'Acceso denegado: permiso insuficiente' });
    }
    // Permisos resueltos desde Firestore (no confiar en el claim del JWT).
    req.userPermissions = permissions;
    next();
  } catch (err) {
    res.status(500).json({ message: 'Error al validar permisos', error: err.message });
  }
};

module.exports = {
  getJwtSecret,
  getRoleTemplates,
  getUserPermissions,
  userToJSON,
  auth,
  authorize,
  requirePermission,
  requireAnyPermission
};
