const bcrypt = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 8;

/**
 * Política mínima de contraseña nueva.
 * @returns {string|null} mensaje de error o null si es válida
 */
const validateNewPassword = (newPassword, { username = '', currentPassword = '' } = {}) => {
  const next = String(newPassword || '');
  if (next.length < MIN_PASSWORD_LENGTH) {
    return `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  const user = String(username || '').trim().toLowerCase();
  if (user && next.trim().toLowerCase() === user) {
    return 'La nueva contraseña no puede ser igual al nombre de usuario';
  }
  if (currentPassword && next === String(currentPassword)) {
    return 'La nueva contraseña no puede ser igual a la actual';
  }
  return null;
};

/**
 * Cambia la contraseña del propio usuario autenticado.
 * @param {{ db: object, FieldValue: object, userId: string, currentPassword: string, newPassword: string }} args
 */
const changeOwnPassword = async ({
  db,
  FieldValue,
  userId,
  currentPassword,
  newPassword
}) => {
  if (!userId) {
    const err = new Error('Usuario no autenticado');
    err.status = 401;
    throw err;
  }
  if (!currentPassword || !newPassword) {
    const err = new Error('Contraseña actual y nueva son obligatorias');
    err.status = 400;
    throw err;
  }

  const userRef = db.collection('users').doc(userId);
  const snap = await userRef.get();
  if (!snap.exists) {
    const err = new Error('Usuario no encontrado');
    err.status = 404;
    throw err;
  }

  const user = snap.data() || {};
  const username = user.username || userId;

  const policyError = validateNewPassword(newPassword, {
    username,
    currentPassword
  });
  if (policyError) {
    const err = new Error(policyError);
    err.status = 400;
    throw err;
  }

  const isMatch = await bcrypt.compare(String(currentPassword), user.password || '');
  if (!isMatch) {
    const err = new Error('La contraseña actual es incorrecta');
    err.status = 401;
    throw err;
  }

  const sameAsHash = await bcrypt.compare(String(newPassword), user.password || '');
  if (sameAsHash) {
    const err = new Error('La nueva contraseña no puede ser igual a la actual');
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  const passwordVersion = (Number(user.passwordVersion) || 1) + 1;
  await userRef.update({
    password: passwordHash,
    mustChangePassword: false,
    passwordVersion,
    passwordChangedAt: FieldValue.serverTimestamp()
  });

  try {
    const {
      invalidatePasswordVersionCache,
      setCachedPasswordVersion
    } = require('./passwordVersion');
    invalidatePasswordVersionCache(userId);
    setCachedPasswordVersion(userId, passwordVersion);
  } catch {
    // ignore cache helpers en entornos de test mínimos
  }

  return {
    id: userId,
    username,
    mustChangePassword: false,
    passwordVersion
  };
};

module.exports = {
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  changeOwnPassword
};
