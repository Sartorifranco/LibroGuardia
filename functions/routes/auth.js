/**
 * Auth, setup bootstrap y health.
 * Paths absolutos /api/... porque setup y auth no comparten el mismo prefijo.
 */

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, FieldValue } = require('../firestore');
const { getRoleById } = require('../roles');
const {
  checkLoginRateLimit,
  recordFailedLogin,
  clearLoginFailures,
  recordSuccessfulLogin,
  isTechnicalAccount,
  getClientIp,
  LOCKOUT_MESSAGE,
  checkPairingRateLimit,
  recordPairingFailure
} = require('../lib/loginRateLimit');
const { exchangePairingCode } = require('../lib/lectorPairing');
const { resolveApiBaseUrl } = require('../lib/lectores');
const { seedInitialUsers, isBootstrapCompleted, INITIAL_USERS } = require('../seedUsers');
const { changeOwnPassword } = require('../lib/changePassword');
const { selfRegisterEmployee } = require('../lib/selfRegister');
const {
  getPasswordVersion,
  cacheUserAuthState
} = require('../lib/passwordVersion');
const {
  auth,
  signAuthToken,
  sendServerError,
  getUserPermissions,
  userToJSON
} = require('../middleware/auth');

const router = express.Router();

router.get('/api/health', async (_req, res) => {
  try {
    await db.collection('users').limit(1).get();
    res.json({ status: 'ok', database: 'firestore', platform: 'firebase-functions' });
  } catch (err) {
    console.error('[api] health:', err?.message || err);
    res.status(503).json({ status: 'error', database: 'firestore' });
  }
});

/** Comparación en tiempo constante (hash previo: longitudes distintas no filtran timing). */
const safeEqualSecret = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
};

router.post('/api/setup/initial-users', async (req, res) => {
  try {
    const expectedKey = String(process.env.SETUP_KEY || '').trim();
    if (!expectedKey) {
      // Sin SETUP_KEY configurada el bootstrap HTTP no existe.
      return res.status(404).json({ message: 'Ruta no encontrada' });
    }
    const setupKey = req.headers['x-setup-key'] || req.body?.setupKey;
    if (!safeEqualSecret(typeof setupKey === 'string' ? setupKey : '', expectedKey)) {
      return res.status(403).json({ message: 'Clave de setup inválida' });
    }

    // force: crea los usuarios iniciales faltantes aunque el bootstrap ya se haya
    // ejecutado. Nunca resetea contraseñas de usuarios existentes.
    const force = req.body?.force === true;
    if (!force && await isBootstrapCompleted()) {
      return res.status(403).json({
        message: 'Bootstrap ya ejecutado. Use force: true para crear usuarios iniciales faltantes.'
      });
    }

    const results = await seedInitialUsers();

    // Nunca se devuelven contraseñas: los usuarios nuevos quedan con mustChangePassword.
    res.json({
      message: force ? 'Usuarios iniciales faltantes creados' : 'Usuarios iniciales cargados',
      results: results.map(({ username, role, created }) => ({ username, role, created })),
      admins: INITIAL_USERS
        .filter((user) => user.role === 'admin')
        .map(({ username, role }) => ({ username, role })),
      testUsers: INITIAL_USERS
        .filter((user) => user.username.startsWith('prueba.'))
        .map(({ username, role, label }) => ({
          username,
          role,
          label,
          created: results.find((r) => r.username === username)?.created === true
        })),
      note: 'Los usuarios creados deben cambiar la contraseña en el primer ingreso.'
    });
  } catch (err) {
    sendServerError(res, err, 'Error en bootstrap de usuarios', 'setup/initial-users');
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
    if ((Number(err.status) || 500) >= 500) {
      return sendServerError(res, err, 'Error en el autoregistro', 'auth/self-register');
    }
    res.status(err.status).json({
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
    // Cuentas técnicas (kiosk.* / kiosk_puerta): bloqueo por usuario+IP, no global.
    let technical = isTechnicalAccount({ username });
    const rate = await checkLoginRateLimit(db, { username, ip: clientIp, technical });
    if (rate.blocked) {
      return res.status(429).json({
        message: rate.message || LOCKOUT_MESSAGE,
        retryAfterSeconds: rate.retryAfterSeconds
      });
    }

    const userRef = db.collection('users').doc(username);
    const snap = await userRef.get();

    if (!snap.exists) {
      const afterFail = await recordFailedLogin(db, FieldValue, { username, ip: clientIp, technical });
      if (afterFail.blocked) {
        return res.status(429).json({
          message: afterFail.message || LOCKOUT_MESSAGE,
          retryAfterSeconds: afterFail.retryAfterSeconds
        });
      }
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const user = snap.data();
    if (!technical && isTechnicalAccount({ role: user.role })) {
      // Cuenta técnica sin prefijo kiosk.: se reevalúa con la clave usuario+IP.
      technical = true;
      const techRate = await checkLoginRateLimit(db, { username, ip: clientIp, technical });
      if (techRate.blocked) {
        return res.status(429).json({
          message: techRate.message || LOCKOUT_MESSAGE,
          retryAfterSeconds: techRate.retryAfterSeconds
        });
      }
    }
    if (user.active === false) {
      return res.status(403).json({ message: 'Su cuenta ha sido deshabilitada. Contacte a un administrador.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const afterFail = await recordFailedLogin(db, FieldValue, { username, ip: clientIp, technical });
      if (afterFail.blocked) {
        return res.status(429).json({
          message: afterFail.message || LOCKOUT_MESSAGE,
          retryAfterSeconds: afterFail.retryAfterSeconds
        });
      }
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    await clearLoginFailures(db, { username, ip: clientIp, technical });
    try {
      await userRef.update({ lastLoginAt: new Date().toISOString() });
    } catch (_loginStampErr) {
      // Anotar el último ingreso no puede impedir entrar.
    }
    if (technical) {
      await recordSuccessfulLogin(db, FieldValue, { username, ip: clientIp, technical }).catch((err) => {
        console.warn('[auth/login] No se pudo registrar la IP del login técnico', err.message);
      });
    }

    const permissions = await getUserPermissions(user);
    const roleMeta = await getRoleById(user.role);
    const passwordVersion = getPasswordVersion(user);
    const token = signAuthToken(
      {
        id: snap.id,
        // Claim explícito para endpoints que identifican por username
        // (p.ej. heartbeat → usuarioSistemaId). No asumir que id === username.
        username: user.username || snap.id,
        role: user.role,
        permissions,
        passwordVersion
      },
      { expiresIn: '8h' }
    );
    cacheUserAuthState(snap.id, user);
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
    sendServerError(res, err, 'Error al iniciar sesión', 'auth/login');
  }
});

/**
 * Público: canjea código de 6 dígitos → config completa del lector (password nueva).
 * Rate limit por IP (mismo criterio que login) + mensaje genérico ante código inválido.
 */
router.post('/api/auth/pairing-exchange', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const rate = await checkPairingRateLimit(db, { ip: clientIp });
    if (rate.blocked) {
      return res.status(429).json({
        message: rate.message || LOCKOUT_MESSAGE,
        retryAfterSeconds: rate.retryAfterSeconds
      });
    }

    const apiBaseUrl = resolveApiBaseUrl(req);
    const result = await exchangePairingCode(req.body?.code || req.body?.pairingCode, {
      apiBaseUrl
    });
    res.json(result);
  } catch (err) {
    if (err.code === 'invalid_pairing_code' || err.status === 400) {
      const afterFail = await recordPairingFailure(db, FieldValue, { ip: getClientIp(req) });
      if (afterFail.blocked) {
        return res.status(429).json({
          message: afterFail.message || LOCKOUT_MESSAGE,
          retryAfterSeconds: afterFail.retryAfterSeconds
        });
      }
      return res.status(400).json({
        message: err.message || 'Código inválido o expirado',
        code: 'invalid_pairing_code'
      });
    }
    if ((Number(err.status) || 500) >= 500) {
      return sendServerError(res, err, 'Error en emparejamiento', 'auth/pairing-exchange');
    }
    res.status(err.status).json({
      message: err.message || 'Error en emparejamiento',
      code: err.code
    });
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
    if (status >= 500) {
      return sendServerError(res, err, 'Error al cambiar la contraseña', 'auth/change-password');
    }
    res.status(status).json({
      message: err.message || 'Error al cambiar la contraseña'
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
    cacheUserAuthState(req.user.id, data);
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
    sendServerError(res, err, 'Error al obtener datos del usuario', 'auth/me');
  }
});

module.exports = router;
