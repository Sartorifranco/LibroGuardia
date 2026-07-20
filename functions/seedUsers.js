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

const upsertUser = async (user) => {
  const username = normalizeUsername(user.username);
  const passwordHash = await bcrypt.hash(user.password, 10);
  const ref = db.collection('users').doc(username);
  const existing = await ref.get();
  const passwordVersion = existing.exists
    ? (Number(existing.data().passwordVersion) || 1) + 1
    : 1;
  await ref.set({
    username,
    password: passwordHash,
    role: user.role,
    active: true,
    passwordVersion,
    displayName: user.label || username,
    updatedAt: FieldValue.serverTimestamp(),
    ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
  }, { merge: true });
  return { username, role: user.role, created: !existing.exists };
};

const seedInitialUsers = async () => {
  await seedSystemRoles();
  const results = [];
  for (const user of INITIAL_USERS) {
    results.push(await upsertUser(user));
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
