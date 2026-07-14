const { db, FieldValue } = require('./firestore');
const { PERMISSION_KEYS, DEFAULT_ROLE_PERMISSIONS } = require('./permissions');

const DASHBOARD_PROFILES = ['monitoreo', 'guardia', 'supervisor', 'admin', 'operational'];

const SYSTEM_ROLE_META = {
  monitoreo: {
    label: 'Monitoreo',
    description: 'Portón de vehículos livianos, directivos, clientes y grúas. Autorización de vehículos y novedades.',
    dashboardProfile: 'monitoreo',
    sortOrder: 1
  },
  guardia: {
    label: 'Guardia',
    description: 'Portón de unidades blindadas y acceso principal a planta. Personal, molinete y novedades.',
    dashboardProfile: 'guardia',
    sortOrder: 2
  },
  supervisor: {
    label: 'Supervisor',
    description: 'Operación completa de guardia y monitoreo, gestión de maestros y usuarios. Sin configuración técnica.',
    dashboardProfile: 'supervisor',
    sortOrder: 3
  },
  admin: {
    label: 'Administrador',
    description: 'Acceso total al sistema incluyendo configuración técnica.',
    dashboardProfile: 'admin',
    sortOrder: 4
  }
};

const slugifyRoleId = (value = '') => String(value)
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 48);

const roleToJSON = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    label: data.label || doc.id,
    description: data.description || '',
    permissions: Array.isArray(data.permissions) ? data.permissions : [],
    dashboardProfile: data.dashboardProfile || 'operational',
    isSystem: data.isSystem === true,
    sortOrder: Number(data.sortOrder) || 99,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null
  };
};

const sanitizePermissions = (permissions = []) => {
  if (!Array.isArray(permissions)) return [];
  return [...new Set(permissions.filter((perm) => PERMISSION_KEYS.includes(perm)))];
};

const getRoleTemplatesFromFirestore = async () => {
  const roles = await listRoles();
  const templates = { ...DEFAULT_ROLE_PERMISSIONS };
  roles.forEach((role) => {
    templates[role.id] = role.permissions;
  });
  return templates;
};

const listRoles = async () => {
  const snap = await db.collection('roles').orderBy('sortOrder').get();
  if (!snap.empty) {
    return snap.docs.map(roleToJSON);
  }
  await seedSystemRoles();
  const seeded = await db.collection('roles').orderBy('sortOrder').get();
  return seeded.docs.map(roleToJSON);
};

const seedSystemRoles = async () => {
  const batch = db.batch();
  Object.entries(SYSTEM_ROLE_META).forEach(([id, meta]) => {
    const ref = db.collection('roles').doc(id);
    batch.set(ref, {
      label: meta.label,
      description: meta.description,
      permissions: sanitizePermissions(DEFAULT_ROLE_PERMISSIONS[id] || []),
      dashboardProfile: meta.dashboardProfile,
      isSystem: true,
      sortOrder: meta.sortOrder,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();

  const legacySnap = await db.collection('settings').doc('rolePermissions').get();
  if (legacySnap.exists) {
    const legacy = legacySnap.data() || {};
    const updateBatch = db.batch();
    Object.entries(legacy).forEach(([roleId, permissions]) => {
      if (!Array.isArray(permissions)) return;
      const ref = db.collection('roles').doc(roleId);
      updateBatch.set(ref, {
        permissions: sanitizePermissions(permissions),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
    await updateBatch.commit();
  }
};

const getRoleById = async (roleId) => {
  const snap = await db.collection('roles').doc(roleId).get();
  if (!snap.exists) return null;
  return roleToJSON(snap);
};

const roleExists = async (roleId) => {
  const snap = await db.collection('roles').doc(roleId).get();
  return snap.exists;
};

const countUsersWithRole = async (roleId) => {
  const snap = await db.collection('users').where('role', '==', roleId).limit(1).get();
  return snap.size;
};

const createRole = async ({ id, label, description, permissions, dashboardProfile }) => {
  const roleId = slugifyRoleId(id || label);
  if (!roleId) throw new Error('Identificador de rol inválido');
  if (SYSTEM_ROLE_META[roleId]) throw new Error('Ese identificador está reservado para un rol del sistema');

  const existing = await db.collection('roles').doc(roleId).get();
  if (existing.exists) throw new Error('Ya existe un rol con ese identificador');

  const profile = DASHBOARD_PROFILES.includes(dashboardProfile) ? dashboardProfile : 'operational';
  const data = {
    label: String(label || roleId).trim(),
    description: String(description || '').trim(),
    permissions: sanitizePermissions(permissions),
    dashboardProfile: profile,
    isSystem: false,
    sortOrder: 50,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await db.collection('roles').doc(roleId).set(data);
  return { id: roleId, ...data };
};

const updateRole = async (roleId, { label, description, permissions, dashboardProfile }) => {
  const ref = db.collection('roles').doc(roleId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Rol no encontrado');

  const updates = { updatedAt: FieldValue.serverTimestamp() };
  if (label !== undefined) updates.label = String(label).trim();
  if (description !== undefined) updates.description = String(description).trim();
  if (permissions !== undefined) updates.permissions = sanitizePermissions(permissions);
  if (dashboardProfile !== undefined) {
    updates.dashboardProfile = DASHBOARD_PROFILES.includes(dashboardProfile)
      ? dashboardProfile
      : 'operational';
  }

  await ref.update(updates);
  const updated = await ref.get();
  return roleToJSON(updated);
};

const deleteRole = async (roleId) => {
  const snap = await db.collection('roles').doc(roleId).get();
  if (!snap.exists) throw new Error('Rol no encontrado');
  if (snap.data().isSystem) throw new Error('No se puede eliminar un rol del sistema');

  const usersCount = await countUsersWithRole(roleId);
  if (usersCount > 0) throw new Error('No se puede eliminar un rol asignado a usuarios');

  await db.collection('roles').doc(roleId).delete();
  return { id: roleId };
};

const listValidRoleIds = async () => {
  const roles = await listRoles();
  return roles.map((role) => role.id);
};

const canManageTargetRole = async (actorRoleId, targetRoleId) => {
  if (actorRoleId === 'admin') return true;
  const actor = await getRoleById(actorRoleId);
  const target = await getRoleById(targetRoleId);
  if (!actor || !target) return false;
  if (target.id === 'admin') return false;
  if (actor.dashboardProfile === 'supervisor') {
    return ['monitoreo', 'guardia'].includes(target.id) || !target.isSystem;
  }
  return false;
};

module.exports = {
  DASHBOARD_PROFILES,
  SYSTEM_ROLE_META,
  slugifyRoleId,
  listRoles,
  getRoleById,
  roleExists,
  createRole,
  updateRole,
  deleteRole,
  listValidRoleIds,
  getRoleTemplatesFromFirestore,
  canManageTargetRole,
  seedSystemRoles
};
