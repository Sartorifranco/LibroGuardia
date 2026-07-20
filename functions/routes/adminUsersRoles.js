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
  canManageTargetRole
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
  requireAnyPermission
} = require('../middleware/auth');

const router = express.Router();

router.get('/api/admin/permissions/roles', auth, requirePermission('settings.permissions'), async (_req, res) => {
  try {
    const roles = await getRoleTemplates();
    res.json({ roles, permissionKeys: PERMISSION_KEYS });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener permisos por rol', error: err.message });
  }
});

router.put('/api/admin/permissions/roles', auth, requirePermission('settings.permissions'), async (req, res) => {
  try {
    const { roles } = req.body;
    if (!roles || typeof roles !== 'object') {
      return res.status(400).json({ message: 'Formato inválido. Se espera { roles: { guardia: [...], ... } }' });
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
    res.status(500).json({ message: 'Error al actualizar permisos por rol', error: err.message });
  }
});

router.get('/api/admin/roles', auth, requireAnyPermission(['roles.view', 'roles.manage', 'settings.permissions']), async (_req, res) => {
  try {
    const roles = await listRoles();
    res.json({ roles, permissionKeys: PERMISSION_KEYS });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener roles', error: err.message });
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

    const userRef = db.collection('users').doc(id);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const beforePerms = Array.isArray(snap.data().permissions) ? snap.data().permissions : [];
    const customPermissions = permissions.filter((perm) => PERMISSION_KEYS.includes(perm));
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
    res.status(500).json({ message: 'Error al actualizar permisos del usuario', error: err.message });
  }
});

router.post('/api/admin/users', auth, requirePermission('users.create'), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username?.trim() || !password) {
      return res.status(400).json({ message: 'Usuario y contraseña son obligatorios' });
    }

    const validRoles = await listValidRoleIds();
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: 'Rol inválido especificado.' });
    }

    if (!(await canManageTargetRole(req.user.role, role))) {
      return res.status(403).json({ message: 'No tiene permisos para asignar ese rol.' });
    }

    const normalizedUsername = String(username || '').trim().toLowerCase();
    const userRef = db.collection('users').doc(normalizedUsername);
    if ((await userRef.get()).exists) {
      return res.status(400).json({ message: 'El nombre de usuario ya existe' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await userRef.set({
      username: normalizedUsername,
      password: passwordHash,
      role,
      active: true,
      mustChangePassword: true,
      passwordVersion: 1,
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
    res.status(500).json({ message: 'Error al crear usuario', error: err.message });
  }
});

router.get('/api/admin/users', auth, requirePermission('users.view'), async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('username').get();
    res.json({ users: snap.docs.map(userToJSON) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener usuarios', error: err.message });
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
    if (!(await canManageTargetRole(req.user.role, userToUpdate.role))) {
      return res.status(403).json({ message: 'Acceso denegado: no puede editar usuarios con ese rol.' });
    }

    const before = {
      username: userToUpdate.username || id,
      role: userToUpdate.role,
      active: userToUpdate.active !== false,
      passwordChanged: false
    };

    const updates = {};

    if (role) {
      const validRoles = await listValidRoleIds();
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: 'Rol inválido' });
      }
      if (!(await canManageTargetRole(req.user.role, role))) {
        return res.status(403).json({ message: 'No tiene permisos para asignar ese rol.' });
      }
      updates.role = role;
    }

    if (password) {
      updates.password = await bcrypt.hash(password, 10);
      updates.mustChangePassword = true;
      updates.passwordVersion = nextPasswordVersion(userToUpdate);
    }
    if (typeof active === 'boolean' && req.user.id !== id) updates.active = active;

    await userRef.update(updates);
    if (password) {
      invalidatePasswordVersionCache(id);
      setCachedPasswordVersion(id, updates.passwordVersion);
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
        passwordChanged: Boolean(password),
        mustChangePassword: afterData.mustChangePassword === true,
        passwordVersion: getPasswordVersion(afterData)
      }
    }).catch((err) => console.error('auditLog user.update:', err.message));
    res.json({ message: 'Usuario actualizado', user: userToJSON(updated) });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar el usuario', error: err.message });
  }
});

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
    if (!(await canManageTargetRole(req.user.role, userToDelete.role))) {
      return res.status(403).json({ message: 'Acceso denegado: no puede eliminar usuarios con ese rol.' });
    }

    await userRef.delete();
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
    res.status(500).json({ message: 'Error al eliminar usuario', error: err.message });
  }
});

module.exports = router;
