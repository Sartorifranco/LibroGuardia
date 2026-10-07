const bcrypt = require('bcryptjs');
const { db, FieldValue } = require('./firestore');
const { seedSystemRoles } = require('./roles');

const INITIAL_USERS = [
  {
    username: 'sistemas.ti@bacarsa.com.ar',
    password: '123456',
    role: 'admin',
    label: 'Admin Sistemas TI'
  },
  {
    username: 'admin@bacarsa.com.ar',
    password: '123456',
    role: 'admin',
    label: 'Admin Bacar'
  },
  {
    username: 'prueba.monitoreo',
    password: 'Monitoreo123',
    role: 'monitoreo',
    label: 'Prueba Monitoreo'
  },
  {
    username: 'prueba.guardia',
    password: 'Guardia123',
    role: 'guardia',
    label: 'Prueba Guardia'
  },
  {
    username: 'prueba.supervisor',
    password: 'Supervisor123',
    role: 'supervisor',
    label: 'Prueba Supervisor'
  }
];

const normalizeUsername = (value = '') => String(value).trim().toLowerCase();

/**
 * Crea el usuario solo si no existe. Nunca resetea la contraseña (ni el rol)
 * de un usuario existente: re-ejecutar el bootstrap no debe permitir tomar
 * cuentas con contraseñas conocidas.
 * Los usuarios creados acá usan contraseñas por defecto conocidas → quedan con
 * mustChangePassword para forzar el cambio en el primer login.
 */
const createUserIfMissing = async (user) => {
  const username = normalizeUsername(user.username);
  const ref = db.collection('users').doc(username);
  const existing = await ref.get();
  if (existing.exists) {
    return { username, role: existing.data()?.role || user.role, created: false };
  }
  const passwordHash = await bcrypt.hash(user.password, 10);
  await ref.set({
    username,
    password: passwordHash,
    role: user.role,
    active: true,
    mustChangePassword: true,
    passwordVersion: 1,
    displayName: user.label || username,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  });
  return { username, role: user.role, created: true };
};

const seedInitialUsers = async () => {
  await seedSystemRoles();
  const results = [];
  for (const user of INITIAL_USERS) {
    results.push(await createUserIfMissing(user));
  }
  await db.collection('settings').doc('bootstrap').set({
    completed: true,
    completedAt: FieldValue.serverTimestamp(),
    userCount: results.length
  }, { merge: true });
  return results;
};

const isBootstrapCompleted = async () => {
  const snap = await db.collection('settings').doc('bootstrap').get();
  return snap.exists && snap.data().completed === true;
};

module.exports = {
  INITIAL_USERS,
  seedInitialUsers,
  isBootstrapCompleted
};
