/**
 * Autoregistro de empleados por dominio de empresa.
 */

const bcrypt = require('bcryptjs');
const { db, FieldValue } = require('../firestore');
const { normalizeDomain } = require('./empresasDestinos');
const { validateNewPassword } = require('./changePassword');

const EMPLEADO_ROLE = 'empleado-visitas';

/**
 * @param {string} email
 * @param {{ empresasDocs?: object[] }} [opts] — si pasás empresasDocs, no consulta Firestore (tests).
 */
const findEmpresaByEmailDomain = async (email, { empresasDocs = null } = {}) => {
  const domain = normalizeDomain(email);
  if (!domain) return null;

  let candidates;
  if (Array.isArray(empresasDocs)) {
    candidates = empresasDocs.map((e) => ({ id: e.id, ...e }));
  } else {
    let snap;
    try {
      snap = await db.collection('empresas')
        .where('dominiosPermitidos', 'array-contains', domain)
        .limit(5)
        .get();
    } catch {
      snap = await db.collection('empresas').get();
    }
    candidates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  const matches = candidates
    .filter((e) => e.activa !== false)
    .filter((e) => Array.isArray(e.dominiosPermitidos) && e.dominiosPermitidos.includes(domain));

  return matches[0] || null;
};

const selfRegisterEmployee = async ({ email, password, nombre }) => {
  const emailNorm = String(email || '').trim().toLowerCase();
  const name = String(nombre || '').trim();
  if (!emailNorm || !emailNorm.includes('@')) {
    const err = new Error('Email inválido');
    err.status = 400;
    throw err;
  }
  if (!name) {
    const err = new Error('El nombre es obligatorio');
    err.status = 400;
    throw err;
  }

  const empresa = await findEmpresaByEmailDomain(emailNorm);
  if (!empresa) {
    const err = new Error(
      'Tu dominio de email no está habilitado para autoregistro, contactá al administrador'
    );
    err.status = 400;
    err.code = 'domain_not_allowed';
    throw err;
  }

  const username = emailNorm;
  const policyError = validateNewPassword(password, { username });
  if (policyError) {
    const err = new Error(policyError);
    err.status = 400;
    throw err;
  }

  const userRef = db.collection('users').doc(username);
  const existing = await userRef.get();
  if (existing.exists) {
    const err = new Error('Ya existe una cuenta con ese email');
    err.status = 409;
    throw err;
  }

  // Asegurar rol de sistema en Firestore (idempotente)
  const roleRef = db.collection('roles').doc(EMPLEADO_ROLE);
  const roleSnap = await roleRef.get();
  if (!roleSnap.exists) {
    await roleRef.set({
      label: 'Empleado — visitas',
      description: 'Autoregistro: solo carga y ve sus propias visitas de invitados.',
      permissions: ['visitas.create', 'visitas.view.own'],
      dashboardProfile: 'operational',
      isSystem: true,
      sortOrder: 20,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  const hashed = await bcrypt.hash(String(password), 10);
  const userDoc = {
    username,
    password: hashed,
    role: EMPLEADO_ROLE,
    active: true,
    mustChangePassword: false,
    passwordVersion: 1,
    empresaId: empresa.id,
    nombre: name,
    email: emailNorm,
    // Las visitas de usuarios autoregistrados siempre quedan pendientes de aprobación
    // (ver isSelfRegisteredUser / routes/empleado.js).
    selfRegistered: true,
    // TODO(seguridad): verificar el email (link de confirmación) antes de habilitar la cuenta.
    // Hoy cualquiera que conozca un dominio habilitado puede crear una cuenta.
    permissions: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  await userRef.set(userDoc);

  return {
    id: username,
    username,
    role: EMPLEADO_ROLE,
    empresaId: empresa.id,
    empresaNombre: empresa.nombre,
    nombre: name,
    email: emailNorm,
    mustChangePassword: false
  };
};

/**
 * true si el usuario se creó por autoregistro.
 * Legacy (sin flag): solo el autoregistro guarda `email` en users/{id}; un admin
 * puede marcar selfRegistered:false para confiar en la cuenta.
 */
const isSelfRegisteredUser = (user = {}) => {
  if (!user || typeof user !== 'object') return false;
  if (user.selfRegistered === true) return true;
  if (user.selfRegistered === false) return false;
  return Boolean(user.email);
};

module.exports = {
  EMPLEADO_ROLE,
  isSelfRegisteredUser,
  findEmpresaByEmailDomain,
  selfRegisterEmployee
};
