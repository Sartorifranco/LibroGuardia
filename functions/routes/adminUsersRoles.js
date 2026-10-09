const express = require('express');
const bcrypt = require('bcryptjs');
const { db, FieldValue } = require('../firestore');
const { PERMISSION_KEYS } = require('../permissions');
const {
  listRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  listValidRoleIds,
  getRoleTemplatesFromFirestore,
  canManageTargetRole,
  isPermissionSubset
} = require('../roles');
const { logActivity } = require('../lib/activityLog');
const { logAdminAction } = require('../lib/auditLog');
const {
  getPasswordVersion,
  nextPasswordVersion,
  invalidatePasswordVersionCache,
  setCachedPasswordVersion
} = require('../lib/passwordVersion');
const {
  getRoleTemplates,
  getUserPermissions,
  userToJSON,
  auth,
  requirePermission,
  requireAnyPermission,
  sendServerError
} = require('../middleware/auth');
const { clearLoginFailures, isTechnicalAccount } = require('../lib/loginRateLimit');
const { validateNewPassword } = require('../lib/changePassword');

const router = express.Router();

router.get('/api/admin/permissions/roles', auth, requirePermission('settings.permissions'), async (_req, res) => {
  try {
    const roles = await getRoleTemplates();
    res.json({ roles, permissionKeys: PERMISSION_KEYS });
  } catch (err) {
    sendServerError(res, err, 'Error al obtener permisos por rol');
  }
});

router.put('/api/admin/permissions/roles', auth, requirePermission('settings.permissions'), async (req, res) => {
  try {
    const { roles } = req.body;
    if (!roles || typeof roles !== 'object') {
      return res.status(400).json({ message: 'Formato inválido. Se espera { roles: { guardia: [...], ... } }' });
    }

    // No se crean roles "fantasma": solo roles existentes en la colección roles.
    const validRoleIds = await listValidRoleIds();
    const unknownRoles = Object.keys(roles).filter((roleId) => !validRoleIds.includes(roleId));
    if (unknownRoles.length) {
      return res.status(400).json({
        message: `Rol inexistente: ${unknownRoles.join(', ')}. Creá el rol primero en Roles.`,
        unknownRoles
      });
    }

    const beforeTemplates = await getRoleTemplatesFromFirestore();
    const sanitized = {};
    const batch = db.batch();
    Object.entries(roles).forEach(([roleId, permissions]) => {
      if (!Array.isArray(permissions)) return;
      sanitized[roleId] = permissions.filter((perm) => PERMISSION_KEYS.includes(perm));
      const ref = db.collection('roles').doc(roleId);
      batch.set(ref, {
        permissions: sanitized[roleId],
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    await batch.commit();
    await db.collection('settings').doc('rolePermissions').set(sanitized, { merge: true });
    logAdminAction({
      req,
      action: 'permissions.change',
      targetType: 'role_permissions',
      targetId: 'bulk',
      before: beforeTemplates,
      after: sanitized
    }).catch((err) => console.error('auditLog permissions.change:', err.message));
    res.json({ message: 'Permisos por rol actualizados', roles: sanitized });
  } catch (err) {
    sendServerError(res, err, 'Error al actualizar permisos por rol');
  }
});

router.get('/api/admin/roles', auth, requireAnyPermission(['roles.view', 'roles.manage', 'settings.permissions']), async (_req, res) => {
  try {
    const { ensureKioskRole } = require('../lib/lectores');
    await ensureKioskRole().catch(() => {});
    const roles = await listRoles();
    res.json({ roles, permissionKeys: PERMISSION_KEYS });
  } catch (err) {
    sendServerError(res, err, 'Error al obtener roles');
  }
});

router.post('/api/admin/roles', auth, requirePermission('roles.manage'), async (req, res) => {
  try {
    const role = await createRole(req.body || {});
    logAdminAction({
      req,
      action: 'role.create',
      targetType: 'role',
      targetId: role.id,
      before: null,
      after: role
    }).catch((err) => console.error('auditLog role.create:', err.message));
    res.status(201).json({ message: 'Rol creado exitosamente', role });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Error al crear rol' });
  }
});

router.put('/api/admin/roles/:id', auth, requirePermission('roles.manage'), async (req, res) => {
  try {
    const before = await getRoleById(req.params.id);
    const role = await updateRole(req.params.id, req.body || {});
    logAdminAction({
      req,
      action: 'role.update',
      targetType: 'role',
      targetId: role.id,
      before,
      after: role
    }).catch((err) => console.error('auditLog role.update:', err.message));
    res.json({ message: 'Rol actualizado', role });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Error al actualizar rol' });
  }
});

router.delete('/api/admin/roles/:id', auth, requirePermission('roles.manage'), async (req, res) => {
  try {
    const roleBefore = await getRoleById(req.params.id);
    const result = await deleteRole(req.params.id);
    logActivity(db, FieldValue, {
      actorUsername: req.user.username || req.user.id,
      actorId: req.user.id,
      action: 'role.delete',
      summary: `Eliminó el rol “${roleBefore?.label || result?.id || req.params.id}”`,
      meta: { roleId: req.params.id }
    }).catch((err) => console.error('activityLog role.delete:', err.message));
    logAdminAction({
      req,
      action: 'role.delete',
      targetType: 'role',
      targetId: req.params.id,
      before: roleBefore,
      after: null
    }).catch((err) => console.error('auditLog role.delete:', err.message));
    res.json({ message: 'Rol eliminado', role: result });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Error al eliminar rol' });
  }
});

router.put('/api/admin/users/:id/permissions', auth, requirePermission('settings.permissions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ message: 'Se espera un array de permisos' });
    }

    if (String(req.user.id) === String(id)) {
      return res.status(403).json({ message: 'No podés modificar tus propios permisos. Pedíselo a otro administrador.' });
    }

    const userRef = db.collection('users').doc(id);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    // Misma regla que la edición de usuarios: solo sobre roles que el actor puede gestionar.
    if (!(await canManageTargetRole(req.user.role, snap.data().role, req.userPermissions))) {
      return res.status(403).json({ message: 'Acceso denegado: no puede editar usuarios con ese rol.' });
    }

    const beforePerms = Array.isArray(snap.data().permissions) ? snap.data().permissions : [];
    const customPermissions = permissions.filter((perm) => PERMISSION_KEYS.includes(perm));
    // Un no-admin no puede otorgar permisos que él mismo no tiene.
    if (req.user.role !== 'admin' && !isPermissionSubset(customPermissions, req.userPermissions)) {
      return res.status(403).json({ message: 'No podés otorgar permisos que no tenés.' });
    }
    await userRef.update({ permissions: customPermissions });
    const updated = await userRef.get();
    const resolved = await getUserPermissions(updated.data());
    logAdminAction({
      req,
      action: 'user.permissions.update',
      targetType: 'user',
      targetId: id,
      before: { permissions: beforePerms },
      after: { permissions: customPermissions }
    }).catch((err) => console.error('auditLog user.permissions.update:', err.message));
    res.json({ message: 'Permisos personalizados actualizados', user: userToJSON(updated, resolved) });
  } catch (err) {
    sendServerError(res, err, 'Error al actualizar permisos del usuario');
  }
});

router.post('/api/admin/users', auth, requirePermission('users.create'), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username?.trim() || !password) {
      return res.status(400).json({ message: 'Usuario y contraseña son obligatorios' });
    }
    const passwordError = validateNewPassword(password, { username });
    if (passwordError) {
      return res.status(400).json({ message: passwordError.replace('La nueva contraseña', 'La contraseña') });
    }

    const validRoles = await listValidRoleIds();
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: 'Rol inválido especificado.' });
    }

    if (!(await canManageTargetRole(req.user.role, role, req.userPermissions))) {
      return res.status(403).json({ message: 'No tiene permisos para asignar ese rol.' });
    }

    const normalizedUsername = String(username || '').trim().toLowerCase();
    const userRef = db.collection('users').doc(normalizedUsername);
    if ((await userRef.get()).exists) {
      return res.status(400).json({ message: 'El nombre de usuario ya existe' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const empresaId = String(req.body?.empresaId || '').trim() || null;
    await userRef.set({
      username: normalizedUsername,
      password: passwordHash,
      role,
      active: true,
      mustChangePassword: true,
      passwordVersion: 1,
      empresaId,
      createdAt: FieldValue.serverTimestamp()
    });

    const created = {
      id: userRef.id,
      username: normalizedUsername,
      role,
      active: true,
      mustChangePassword: true
    };
    logAdminAction({
      req,
      action: 'user.create',
      targetType: 'user',
      targetId: userRef.id,
      before: null,
      after: created
    }).catch((err) => console.error('auditLog user.create:', err.message));

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: created
    });
  } catch (err) {
    sendServerError(res, err, 'Error al crear usuario');
  }
});

router.get('/api/admin/users', auth, requirePermission('users.view'), async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('username').get();
    res.json({ users: snap.docs.map(userToJSON) });
  } catch (err) {
    sendServerError(res, err, 'Error al obtener usuarios');
  }
});

router.put('/api/admin/users/:id', auth, requirePermission('users.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { role, password, active } = req.body;
    const userRef = db.collection('users').doc(id);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const userToUpdate = snap.data();
    if (!(await canManageTargetRole(req.user.role, userToUpdate.role, req.userPermissions))) {
      return res.status(403).json({ message: 'Acceso denegado: no puede editar usuarios con ese rol.' });
    }

    const before = {
      username: userToUpdate.username || id,
      role: userToUpdate.role,
      active: userToUpdate.active !== false,
      empresaId: userToUpdate.empresaId || null,
      passwordChanged: false
    };

    const updates = {};

    if (role) {
      const validRoles = await listValidRoleIds();
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: 'Rol inválido' });
      }
      if (!(await canManageTargetRole(req.user.role, role, req.userPermissions))) {
        return res.status(403).json({ message: 'No tiene permisos para asignar ese rol.' });
      }
      updates.role = role;
    }

    if (password) {
      const passwordError = validateNewPassword(password, { username: userToUpdate.username || id });
      if (passwordError) {
        return res.status(400).json({ message: passwordError });
      }
      updates.password = await bcrypt.hash(password, 10);
      updates.mustChangePassword = true;
      updates.passwordVersion = nextPasswordVersion(userToUpdate);
    }
    if (typeof active === 'boolean' && req.user.id !== id) updates.active = active;
    if (Object.prototype.hasOwnProperty.call(req.body, 'empresaId')) {
      const empresaId = String(req.body.empresaId || '').trim();
      updates.empresaId = empresaId || null;
    }

    // Desactivar o cambiar el rol invalida las sesiones abiertas (JWT con role/permisos viejos).
    const deactivating = updates.active === false && userToUpdate.active !== false;
    const roleChanged = updates.role !== undefined && updates.role !== userToUpdate.role;
    if ((deactivating || roleChanged) && updates.passwordVersion === undefined) {
      updates.passwordVersion = nextPasswordVersion(userToUpdate);
    }

    await userRef.update(updates);
    if (updates.passwordVersion !== undefined || updates.active !== undefined) {
      invalidatePasswordVersionCache(id);
      setCachedPasswordVersion(
        id,
        updates.passwordVersion !== undefined ? updates.passwordVersion : getPasswordVersion(userToUpdate),
        updates.active !== undefined ? updates.active !== false : userToUpdate.active !== false
      );
    }
    const updated = await userRef.get();
    const afterData = updated.data();
    logAdminAction({
      req,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      before,
      after: {
        username: afterData.username || id,
        role: afterData.role,
        active: afterData.active !== false,
        empresaId: afterData.empresaId || null,
        passwordChanged: Boolean(password),
        mustChangePassword: afterData.mustChangePassword === true,
        passwordVersion: getPasswordVersion(afterData)
      }
    }).catch((err) => console.error('auditLog user.update:', err.message));
    res.json({ message: 'Usuario actualizado', user: userToJSON(updated) });
  } catch (err) {
    sendServerError(res, err, 'Error al actualizar el usuario');
  }
});

/**
 * Destraba bloqueo por intentos fallidos de login (clearLoginFailures).
 * Permiso: users.edit (usuarios generales) o lectores.manage (kiosk).
 */
router.post(
  '/api/admin/users/:id/clear-login-failures',
  auth,
  requireAnyPermission(['users.edit', 'lectores.manage']),
  async (req, res) => {
    try {
      const id = String(req.params.id || '').trim().toLowerCase();
      const userRef = db.collection('users').doc(id);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      const username = String(snap.data()?.username || id).trim().toLowerCase();
      // Cuentas técnicas: limpia también los bloqueos por usuario+IP.
      await clearLoginFailures(db, {
        username,
        technical: isTechnicalAccount({ username, role: snap.data()?.role })
      });
      logAdminAction({
        req,
        action: 'user.clear_login_failures',
        targetType: 'user',
        targetId: id,
        after: { username }
      }).catch(() => {});
      res.json({
        message: `Se destrabaron los intentos de login de “${username}”. Ya puede volver a autenticarse.`,
        username
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al destrabar login'
      });
    }
  }
);

router.delete('/api/admin/users/:id', auth, requirePermission('users.delete'), async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.id === id) {
      return res.status(400).json({ message: 'No puedes eliminar tu propio usuario.' });
    }

    const userRef = db.collection('users').doc(id);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const userToDelete = snap.data();
    if (!(await canManageTargetRole(req.user.role, userToDelete.role, req.userPermissions))) {
      return res.status(403).json({ message: 'Acceso denegado: no puede eliminar usuarios con ese rol.' });
    }

    await userRef.delete();
    // Sin cache, el próximo request del token borrado no encuentra el doc → 401.
    invalidatePasswordVersionCache(id);
    logActivity(db, FieldValue, {
      actorUsername: req.user.username || req.user.id,
      actorId: req.user.id,
      action: 'user.delete',
      summary: `Eliminó el usuario “${userToDelete.username || id}”`,
      meta: { userId: id, role: userToDelete.role }
    }).catch((err) => console.error('activityLog user.delete:', err.message));
    logAdminAction({
      req,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      before: {
        username: userToDelete.username || id,
        role: userToDelete.role,
        active: userToDelete.active !== false
      },
      after: null
    }).catch((err) => console.error('auditLog user.delete:', err.message));
    res.json({ message: 'Usuario eliminado exitosamente' });
  } catch (err) {
    sendServerError(res, err, 'Error al eliminar usuario');
  }
});

module.exports = router;
