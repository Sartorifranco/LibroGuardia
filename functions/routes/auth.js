/**
 * Auth, setup bootstrap y health.
 * Paths absolutos /api/... porque setup y auth no comparten el mismo prefijo.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, FieldValue } = require('../firestore');
const { getRoleById } = require('../roles');
const {
  checkLoginRateLimit,
  recordFailedLogin,
  clearLoginFailures,
  getClientIp,
  LOCKOUT_MESSAGE
} = require('../lib/loginRateLimit');
const { seedInitialUsers, isBootstrapCompleted, INITIAL_USERS } = require('../seedUsers');
const { changeOwnPassword } = require('../lib/changePassword');
const { selfRegisterEmployee } = require('../lib/selfRegister');
const {
  getPasswordVersion,
  setCachedPasswordVersion
} = require('../lib/passwordVersion');
const {
  auth,
  getJwtSecret,
  getUserPermissions,
  userToJSON
} = require('../middleware/auth');

const router = express.Router();

router.get('/api/health', async (_req, res) => {
  try {
    await db.collection('users').limit(1).get();
    res.json({ status: 'ok', database: 'firestore', platform: 'firebase-functions' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'firestore', error: err.message });
  }
});

router.post('/api/setup/initial-users', async (req, res) => {
  try {
    const setupKey = req.headers['x-setup-key'] || req.body?.setupKey;
    const expectedKey = process.env.SETUP_KEY || 'bacar-lg-setup-2026';
    if (!setupKey || setupKey !== expectedKey) {
      return res.status(403).json({ message: 'Clave de setup inválida' });
    }

    const force = req.body?.force === true;
    if (!force && await isBootstrapCompleted()) {
      return res.status(403).json({
        message: 'Bootstrap ya ejecutado. Use force: true para actualizar usuarios iniciales.'
      });
    }

    const results = await seedInitialUsers();
    const testUsers = INITIAL_USERS
      .filter((user) => user.username.startsWith('prueba.'))
      .map(({ username, password, role, label }) => ({ username, password, role, label }));

    res.json({
      message: force ? 'Usuarios iniciales actualizados' : 'Usuarios iniciales cargados',
      results,
      admins: INITIAL_USERS
        .filter((user) => user.role === 'admin')
        .map(({ username, role }) => ({ username, role })),
      testUsers
    });
  } catch (err) {
    res.status(500).json({ message: 'Error en bootstrap de usuarios', error: err.message });
  }
});

router.post('/api/auth/register', (_req, res) => {
  res.status(403).json({
    message: 'El registro público está deshabilitado. Solicite a un administrador que cree su usuario.'
  });
});

router.post('/api/auth/self-register', async (req, res) => {
  try {
    const user = await selfRegisterEmployee({
      email: req.body?.email,
      password: req.body?.password,
      nombre: req.body?.nombre || req.body?.name
    });
    res.status(201).json({
      message: 'Cuenta creada. Ya podés iniciar sesión.',
      user
    });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error en el autoregistro',
      code: err.code
    });
  }
});

router.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!username || !password) {
      return res.status(400).json({ message: 'Usuario y contraseña son obligatorios' });
    }

    const clientIp = getClientIp(req);
    const rate = await checkLoginRateLimit(db, { username, ip: clientIp });
    if (rate.blocked) {
      return res.status(429).json({
        message: rate.message || LOCKOUT_MESSAGE,
        retryAfterSeconds: rate.retryAfterSeconds
      });
    }

    const userRef = db.collection('users').doc(username);
    const snap = await userRef.get();

    if (!snap.exists) {
      const afterFail = await recordFailedLogin(db, FieldValue, { username, ip: clientIp });
      if (afterFail.blocked) {
        return res.status(429).json({
          message: afterFail.message || LOCKOUT_MESSAGE,
          retryAfterSeconds: afterFail.retryAfterSeconds
        });
      }
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const user = snap.data();
    if (user.active === false) {
      return res.status(403).json({ message: 'Su cuenta ha sido deshabilitada. Contacte a un administrador.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const afterFail = await recordFailedLogin(db, FieldValue, { username, ip: clientIp });
      if (afterFail.blocked) {
        return res.status(429).json({
          message: afterFail.message || LOCKOUT_MESSAGE,
          retryAfterSeconds: afterFail.retryAfterSeconds
        });
      }
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    await clearLoginFailures(db, { username });

    const permissions = await getUserPermissions(user);
    const roleMeta = await getRoleById(user.role);
    const passwordVersion = getPasswordVersion(user);
    const token = jwt.sign(
      {
        id: snap.id,
        // Claim explícito para endpoints que identifican por username
        // (p.ej. heartbeat → usuarioSistemaId). No asumir que id === username.
        username: user.username || snap.id,
        role: user.role,
        permissions,
        passwordVersion
      },
      getJwtSecret(),
      { expiresIn: '8h' }
    );
    setCachedPasswordVersion(snap.id, passwordVersion);
    res.json({
      token,
      user: {
        id: snap.id,
        username: user.username,
        role: user.role,
        roleLabel: roleMeta?.label || user.role,
        dashboardProfile: roleMeta?.dashboardProfile || user.role,
        active: user.active !== false,
        mustChangePassword: user.mustChangePassword === true,
        permissions,
        customPermissions: user.permissions || [],
        empresaId: user.empresaId || null,
        nombre: user.nombre || null,
        email: user.email || null
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al iniciar sesión', error: err.message });
  }
});

router.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const result = await changeOwnPassword({
      db,
      FieldValue,
      userId: req.user.id,
      currentPassword,
      newPassword
    });
    res.json({
      message: 'Contraseña actualizada correctamente',
      user: {
        id: result.id,
        username: result.username,
        mustChangePassword: false
      }
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      message: err.message || 'Error al cambiar la contraseña',
      ...(status === 500 ? { error: err.message } : {})
    });
  }
});

router.get('/api/auth/me', auth, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.id).get();
    if (!snap.exists) {
      // Token pasó firma/versión pero el doc ya no está: sesión inválida.
      return res.status(401).json({ message: 'Token no válido' });
    }
    const data = snap.data() || {};
    if (data.active === false) {
      return res.status(403).json({
        message: 'Su cuenta ha sido deshabilitada. Contacte a un administrador.'
      });
    }
    // Refresca cache con la versión actual (defensivo ante desync).
    setCachedPasswordVersion(req.user.id, getPasswordVersion(data));
    const permissions = await getUserPermissions(data);
    const roleMeta = await getRoleById(data.role);
    res.json({
      user: {
        ...userToJSON(snap, permissions),
        roleLabel: roleMeta?.label || data.role,
        dashboardProfile: roleMeta?.dashboardProfile || data.role
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener datos del usuario', error: err.message });
  }
});

module.exports = router;
