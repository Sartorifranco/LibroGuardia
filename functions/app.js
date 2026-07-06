const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { db, FieldValue, Timestamp } = require('./firestore');
const {
  PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  normalizeIdNumber,
  normalizePlate,
  parseScanData,
  resolvePermissions
} = require('./permissions');
const {
  DEFAULT_ACCESS_CONTROL,
  getAccessControlConfig,
  evaluatePersonalAccess,
  triggerAccessIfAuthorized,
  triggerRelay,
  logAccessEvent,
  processKioskScan,
  validarAcceso
} = require('./accessControl');
const {
  buildAuthorizationRecord,
  listAuthorizationsByDate,
  listAuthorizationsInRange,
  listPlannedCitacionDates,
  resolveAuthorization,
  getAuthorizationLabel,
  AUTHORIZATION_TYPES
} = require('./authorizations');
const { parseImportRows } = require('./citacionesImport');
const {
  getCitacionesBridgeConfig,
  saveCitacionesBridgeConfig,
  verifyCitacionesBridgeRequest,
  syncAuthorizationsFromBridge,
  listCitacionesImports,
  getCitacionesImportById
} = require('./citacionesBridge');
const { resolveOrCreatePerson } = require('./people');
const {
  checkAccessStatus,
  preRegisterVisitor,
  registerExceptionalEntry
} = require('./guard');
const {
  getFleetGpsConfig,
  publicFleetGpsConfig,
  saveFleetGpsConfig,
  fetchNearbyFleetAlerts
} = require('./fleetGps');
const { importNominaRows, listNominaPersonal } = require('./nominaImport');
const {
  getMissingAttendanceAlerts,
  dismissAttendanceAlert,
  bulkDismissAttendance
} = require('./attendanceAlerts');

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  'http://localhost:3000,https://bacarguard.web.app,https://bacarguard.firebaseapp.com'
).split(',').map((origin) => origin.trim());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  }
}));
app.use(express.json({ limit: '5mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'El archivo es demasiado grande. Reduzca filas o vuelva a exportar la planilla.' });
  }
  return next(err);
});

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no configurada');
  return secret;
};

const getRoleTemplates = async () => {
  const snap = await db.collection('settings').doc('rolePermissions').get();
  if (!snap.exists) return DEFAULT_ROLE_PERMISSIONS;
  return { ...DEFAULT_ROLE_PERMISSIONS, ...snap.data() };
};

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
    permissions: permissions || data.permissions || [],
    customPermissions: data.permissions || []
  };
};

const entryToJSON = (doc, registeredByUsername) => {
  const data = doc.data();
  const timestamp = data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : data.timestamp;
  return {
    id: doc.id,
    _id: doc.id,
    ...data,
    timestamp,
    registeredByUsername
  };
};

const auth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ message: 'No token, autorización denegada' });
  }
  try {
    req.user = jwt.verify(token, getJwtSecret());
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token no válido' });
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

const todayDateString = () => new Date().toISOString().slice(0, 10);

const validateEntryPayload = (type, body) => {
  switch (type) {
    case 'personal':
      if (!body.name?.trim()) return 'El nombre es obligatorio para registros de personal';
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'vehiculo':
      if (!body.plate?.trim()) return 'La patente es obligatoria para vehículos';
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'flota':
      if (!body.mobile?.trim() || !body.flotaDriver?.trim()) {
        return 'El móvil y el chofer son obligatorios para flota';
      }
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'novedad':
      if (!body.description?.trim()) return 'La descripción es obligatoria para novedades';
      break;
    default:
      return 'Tipo de entrada inválido';
  }
  return null;
};

const deleteCollection = async (collectionName, batchSize = 100) => {
  const collectionRef = db.collection(collectionName);
  const snapshot = await collectionRef.limit(batchSize).get();
  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  if (snapshot.size >= batchSize) {
    await deleteCollection(collectionName, batchSize);
  }
};

app.get('/api/health', async (_req, res) => {
  try {
    await db.collection('users').limit(1).get();
    res.json({ status: 'ok', database: 'firestore', platform: 'firebase-functions' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'firestore', error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username?.trim() || !password) {
      return res.status(400).json({ message: 'Usuario y contraseña son obligatorios' });
    }

    const normalizedUsername = username.trim();
    const userRef = db.collection('users').doc(normalizedUsername);
    const existing = await userRef.get();
    if (existing.exists) {
      return res.status(400).json({ message: 'El nombre de usuario ya existe' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userData = {
      username: normalizedUsername,
      password: passwordHash,
      role: 'guardia',
      active: true,
      createdAt: FieldValue.serverTimestamp()
    };
    await userRef.set(userData);

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      user: { id: userRef.id, username: normalizedUsername, role: 'guardia', active: true }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar usuario', error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const userRef = db.collection('users').doc(username);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const user = snap.data();
    if (user.active === false) {
      return res.status(403).json({ message: 'Su cuenta ha sido deshabilitada. Contacte a un administrador.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const permissions = await getUserPermissions(user);
    const token = jwt.sign({ id: snap.id, role: user.role, permissions }, getJwtSecret(), { expiresIn: '8h' });
    res.json({
      token,
      user: {
        id: snap.id,
        username: user.username,
        role: user.role,
        active: user.active !== false,
        permissions,
        customPermissions: user.permissions || []
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al iniciar sesión', error: err.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.id).get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    const permissions = await getUserPermissions(snap.data());
    res.json({ user: userToJSON(snap, permissions) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener datos del usuario', error: err.message });
  }
});

app.get('/api/admin/permissions/roles', auth, requirePermission('settings.permissions'), async (_req, res) => {
  try {
    const roles = await getRoleTemplates();
    res.json({ roles, permissionKeys: PERMISSION_KEYS });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener permisos por rol', error: err.message });
  }
});

app.put('/api/admin/permissions/roles', auth, requirePermission('settings.permissions'), async (req, res) => {
  try {
    const { roles } = req.body;
    if (!roles || typeof roles !== 'object') {
      return res.status(400).json({ message: 'Formato inválido. Se espera { roles: { guardia: [...], ... } }' });
    }

    const sanitized = {};
    Object.entries(roles).forEach(([role, permissions]) => {
      if (!Array.isArray(permissions)) return;
      sanitized[role] = permissions.filter((perm) => PERMISSION_KEYS.includes(perm));
    });

    await db.collection('settings').doc('rolePermissions').set(sanitized, { merge: true });
    res.json({ message: 'Permisos por rol actualizados', roles: sanitized });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar permisos por rol', error: err.message });
  }
});

app.put('/api/admin/users/:id/permissions', auth, requirePermission('settings.permissions'), async (req, res) => {
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

    const customPermissions = permissions.filter((perm) => PERMISSION_KEYS.includes(perm));
    await userRef.update({ permissions: customPermissions });
    const updated = await userRef.get();
    const resolved = await getUserPermissions(updated.data());
    res.json({ message: 'Permisos personalizados actualizados', user: userToJSON(updated, resolved) });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar permisos del usuario', error: err.message });
  }
});

app.post('/api/admin/users', auth, authorize('admin'), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username?.trim() || !password) {
      return res.status(400).json({ message: 'Usuario y contraseña son obligatorios' });
    }
    if (!['guardia', 'admin', 'supervisor'].includes(role)) {
      return res.status(400).json({ message: 'Rol inválido especificado.' });
    }

    const normalizedUsername = username.trim();
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
      createdAt: FieldValue.serverTimestamp()
    });

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: { id: userRef.id, username: normalizedUsername, role, active: true }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear usuario', error: err.message });
  }
});

app.get('/api/admin/users', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('username').get();
    res.json({ users: snap.docs.map(userToJSON) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener usuarios', error: err.message });
  }
});

app.put('/api/admin/users/:id', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const { id } = req.params;
    const { role, password, active } = req.body;
    const userRef = db.collection('users').doc(id);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const userToUpdate = snap.data();
    const updates = {};

    if (req.user.role === 'admin') {
      if (role) {
        if (!['guardia', 'admin', 'supervisor'].includes(role)) {
          return res.status(400).json({ message: 'Rol inválido' });
        }
        updates.role = role;
      }
      if (password) updates.password = await bcrypt.hash(password, 10);
      if (typeof active === 'boolean') updates.active = active;
    } else if (req.user.role === 'supervisor') {
      if (userToUpdate.role !== 'guardia') {
        return res.status(403).json({ message: 'Acceso denegado: Un supervisor solo puede editar usuarios con rol "guardia".' });
      }
      if (role && userToUpdate.role !== role) {
        return res.status(403).json({ message: 'Acceso denegado: Un supervisor no puede cambiar el rol de un usuario.' });
      }
      if (password) updates.password = await bcrypt.hash(password, 10);
      if (typeof active === 'boolean') updates.active = active;
    } else {
      return res.status(403).json({ message: 'Acceso denegado: No tiene permisos para editar usuarios.' });
    }

    await userRef.update(updates);
    const updated = await userRef.get();
    res.json({ message: 'Usuario actualizado', user: userToJSON(updated) });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar el usuario', error: err.message });
  }
});

app.delete('/api/admin/users/:id', auth, authorize(['admin', 'supervisor']), async (req, res) => {
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
    if (req.user.role === 'admin') {
      await userRef.delete();
    } else if (req.user.role === 'supervisor') {
      if (userToDelete.role !== 'guardia') {
        return res.status(403).json({ message: 'Acceso denegado: Un supervisor solo puede eliminar usuarios con rol "guardia".' });
      }
      await userRef.delete();
    } else {
      return res.status(403).json({ message: 'Acceso denegado: No tiene permisos para eliminar usuarios.' });
    }

    res.json({ message: 'Usuario eliminado exitosamente' });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar usuario', error: err.message });
  }
});

app.post('/api/admin/fleet/mobiles/upload', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0 || data.some((item) => typeof item.name !== 'string' || !item.name.trim())) {
      return res.status(400).json({ message: 'Formato de datos inválido. Se espera un array no vacío con objetos { name }.' });
    }

    await deleteCollection('mobiles');
    const batch = db.batch();
    data.forEach((item) => {
      const ref = db.collection('mobiles').doc();
      batch.set(ref, { name: item.name.trim() });
    });
    await batch.commit();

    res.status(200).json({ message: 'Lista de móviles actualizada exitosamente.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir la lista de móviles', error: err.message });
  }
});

app.post('/api/admin/fleet/drivers/upload', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0 || data.some((item) => typeof item.name !== 'string' || !item.name.trim())) {
      return res.status(400).json({ message: 'Formato de datos inválido. Se espera un array no vacío con objetos { name }.' });
    }

    await deleteCollection('drivers');
    const batch = db.batch();
    data.forEach((item) => {
      const ref = db.collection('drivers').doc();
      batch.set(ref, { name: item.name.trim() });
    });
    await batch.commit();

    res.status(200).json({ message: 'Lista de choferes actualizada exitosamente.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir la lista de choferes', error: err.message });
  }
});

app.get('/api/fleet/mobiles', auth, async (_req, res) => {
  try {
    const snap = await db.collection('mobiles').orderBy('name').get();
    res.json({ mobiles: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener móviles', error: err.message });
  }
});

app.get('/api/fleet/drivers', auth, async (_req, res) => {
  try {
    const snap = await db.collection('drivers').orderBy('name').get();
    res.json({ drivers: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener choferes', error: err.message });
  }
});

app.get('/api/master-data/personal', auth, async (_req, res) => {
  try {
    const snap = await db.collection('personalMaster').orderBy('name').get();
    res.json({ personal: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener datos maestros de personal', error: err.message });
  }
});

app.post('/api/master-data/personal', auth, async (req, res) => {
  try {
    const { name, idNumber, company, destination } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ message: 'El nombre es obligatorio' });
    }

    const normalizedName = name.trim();
    const nameLower = normalizedName.toLowerCase();
    const existing = await db.collection('personalMaster').where('nameLower', '==', nameLower).limit(1).get();

    let personRef;
    let personData;

    if (!existing.empty) {
      personRef = existing.docs[0].ref;
      personData = {
        name: normalizedName,
        nameLower,
        idNumber: idNumber || existing.docs[0].data().idNumber || '',
        idNumberNormalized: normalizeIdNumber(idNumber || existing.docs[0].data().idNumber || ''),
        company: company || existing.docs[0].data().company || '',
        destination: destination || existing.docs[0].data().destination || ''
      };
      await personRef.update(personData);
    } else {
      personRef = db.collection('personalMaster').doc();
      personData = {
        name: normalizedName,
        nameLower,
        idNumber: idNumber || '',
        idNumberNormalized: normalizeIdNumber(idNumber || ''),
        company: company || '',
        destination: destination || ''
      };
      await personRef.set(personData);
    }

    res.status(201).json({
      message: 'Persona guardada en la base maestra',
      personal: { id: personRef.id, ...personData }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar persona en la base maestra', error: err.message });
  }
});

app.get('/api/master-data/personal/by-dni/:dni', auth, requirePermission('master.personal.read'), async (req, res) => {
  try {
    const idNumber = normalizeIdNumber(req.params.dni);
    if (!idNumber) {
      return res.status(400).json({ message: 'DNI inválido' });
    }

    const snap = await db.collection('personalMaster')
      .where('idNumberNormalized', '==', idNumber)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ message: 'Persona no encontrada en la base precargada', idNumber });
    }

    const doc = snap.docs[0];
    res.json({ personal: { id: doc.id, ...doc.data() } });
  } catch (err) {
    res.status(500).json({ message: 'Error al buscar persona por DNI', error: err.message });
  }
});

app.get('/api/master-data/citaciones', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const date = req.query.date || todayDateString();
    const authorizations = await listAuthorizationsByDate(date);
    res.json({
      citaciones: authorizations,
      authorizations,
      date
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener citaciones', error: err.message });
  }
});

const listAuthorizationsHandler = async (req, res) => {
  try {
    const type = req.query.type || null;
    const { from, to, date, planned } = req.query;

    if (from && to) {
      const authorizations = await listAuthorizationsInRange(from, to, type || null);
      const plannedDates = await listPlannedCitacionDates(from, to);
      return res.json({ authorizations, from, to, plannedDates, mode: 'range' });
    }

    if (planned === 'true') {
      const start = date || todayDateString();
      const endDate = new Date(`${start}T12:00:00`);
      endDate.setDate(endDate.getDate() + 14);
      const end = endDate.toISOString().slice(0, 10);
      const authorizations = await listAuthorizationsInRange(start, end, type || 'citacion');
      const plannedDates = await listPlannedCitacionDates(start, end);
      return res.json({ authorizations, from: start, to: end, plannedDates, mode: 'planned' });
    }

    const targetDate = date || todayDateString();
    const authorizations = await listAuthorizationsByDate(targetDate, type || null);
    res.json({ authorizations, date: targetDate, mode: 'day' });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener autorizaciones', error: err.message });
  }
};

app.get('/api/admin/authorizations', auth, requirePermission('master.citaciones.read'), listAuthorizationsHandler);
app.get('/api/guard/authorizations', auth, requirePermission('master.citaciones.read'), listAuthorizationsHandler);

app.get('/api/admin/citaciones-imports', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const imports = await listCitacionesImports({ limit });
    res.json({ imports });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar importaciones', error: err.message });
  }
});

app.get('/api/admin/citaciones-imports/:id', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const batch = await getCitacionesImportById(req.params.id);
    if (!batch) {
      return res.status(404).json({ message: 'Importación no encontrada' });
    }
    res.json({ import: batch });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener importación', error: err.message });
  }
});

app.post('/api/admin/authorizations', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const data = buildAuthorizationRecord({ ...req.body, source: 'manual' });
    const person = await resolveOrCreatePerson(data, {
      origen: 'manual',
      tipo: req.body.personTipo || 'empleado'
    });

    const ref = await db.collection('authorizations').add({
      ...data,
      personId: person.id,
      source: 'manual',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user?.username || req.user?.id || 'admin'
    });

    if (data.type === 'citacion') {
      await db.collection('citaciones').add({
        name: data.name,
        idNumber: data.idNumber,
        idNumberNormalized: data.idNumberNormalized,
        legajo: data.legajo,
        legajoNormalized: data.legajoNormalized,
        company: data.company,
        destination: data.destination,
        appointmentDate: data.startDate,
        notes: data.notes,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    res.status(201).json({
      message: 'Autorización registrada',
      authorization: { id: ref.id, ...data, personId: person.id }
    });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Error al guardar autorización' });
  }
});

app.delete('/api/admin/authorizations/:id', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const ref = db.collection('authorizations').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Autorización no encontrada' });
    }
    await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
    res.json({ message: 'Autorización desactivada' });
  } catch (err) {
    res.status(500).json({ message: 'Error al desactivar autorización', error: err.message });
  }
});

app.post('/api/admin/authorizations/upload', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const { data, defaults } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de autorizaciones' });
    }

    const { parsed, errors } = parseImportRows(data, defaults || {});
    if (!parsed.length) {
      return res.status(400).json({
        message: errors[0]?.message || 'No se encontraron filas válidas. Columnas: tipo, nombre, dni, empresa, destino, fecha_inicio, fecha_fin',
        errors
      });
    }

    const batch = db.batch();
    parsed.forEach((record) => {
      const ref = db.collection('authorizations').doc();
      batch.set(ref, { ...record, createdAt: FieldValue.serverTimestamp() });
    });

    await batch.commit();
    res.status(200).json({
      message: `${parsed.length} autorizaciones cargadas exitosamente`,
      count: parsed.length,
      skippedInvalid: errors.length
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al cargar autorizaciones', error: err.message });
  }
});

app.get('/api/admin/citaciones-bridge', auth, requirePermission('master.citaciones.write'), async (_req, res) => {
  try {
    const config = await getCitacionesBridgeConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ message: 'Error al leer configuración del puente', error: err.message });
  }
});

app.put('/api/admin/citaciones-bridge', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const allowed = ['enabled', 'bridgeSecret', 'watchFolderHint'];
    const updates = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });
    const config = await saveCitacionesBridgeConfig(updates);
    res.json({ message: 'Configuración del puente guardada', config });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar configuración del puente', error: err.message });
  }
});

app.get('/api/bridge/citaciones/health', async (_req, res) => {
  try {
    const config = await getCitacionesBridgeConfig();
    res.json({
      status: 'ok',
      service: 'citaciones-folder-bridge',
      enabled: config.enabled,
      lastSyncAt: config.lastSyncAt,
      lastSyncFile: config.lastSyncFile,
      lastSyncCount: config.lastSyncCount,
      lastSyncError: config.lastSyncError
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/bridge/citaciones/sync', async (req, res) => {
  try {
    await verifyCitacionesBridgeRequest(req);
    const result = await syncAuthorizationsFromBridge(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al sincronizar citaciones',
      details: err.details || undefined
    });
  }
});

app.post('/api/master-data/citaciones', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const { name, idNumber, company, destination, appointmentDate, notes } = req.body;
    if (!name?.trim() || !normalizeIdNumber(idNumber)) {
      return res.status(400).json({ message: 'Nombre y DNI son obligatorios' });
    }

    const idNumberNormalized = normalizeIdNumber(idNumber);
    const data = buildAuthorizationRecord({
      type: 'citacion',
      name,
      idNumber,
      company,
      destination,
      startDate: appointmentDate || todayDateString(),
      endDate: appointmentDate || todayDateString(),
      notes
    });

    const ref = await db.collection('authorizations').add({
      ...data,
      createdAt: FieldValue.serverTimestamp()
    });

    await db.collection('citaciones').add({
      name: data.name,
      idNumber: data.idNumber,
      idNumberNormalized: data.idNumberNormalized,
      company: data.company,
      destination: data.destination,
      appointmentDate: data.startDate,
      notes: data.notes,
      createdAt: FieldValue.serverTimestamp()
    });

    res.status(201).json({ message: 'Citación registrada', citacion: { id: ref.id, ...data } });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar citación', error: err.message });
  }
});

app.delete('/api/master-data/citaciones/:id', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const ref = db.collection('citaciones').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Citación no encontrada' });
    }
    await ref.delete();
    res.json({ message: 'Citación eliminada' });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar citación', error: err.message });
  }
});

app.post('/api/admin/citaciones/upload', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de citaciones' });
    }

    const batch = db.batch();
    let count = 0;

    data.forEach((item) => {
      const name = (item.name || item.nombre || '').trim();
      const idNumberNormalized = normalizeIdNumber(item.idNumber || item.dni || item.documento || '');
      if (!name || !idNumberNormalized) return;

      const ref = db.collection('authorizations').doc();
      batch.set(ref, buildAuthorizationRecord({
        type: 'citacion',
        name,
        idNumber: idNumberNormalized,
        company: (item.company || item.empresa || '').trim(),
        destination: (item.destination || item.destino || item.area || '').trim(),
        startDate: item.appointmentDate || item.fecha || todayDateString(),
        endDate: item.appointmentDate || item.fecha || todayDateString(),
        notes: (item.notes || item.observaciones || '').trim()
      }));
      count += 1;
    });

    if (!count) {
      return res.status(400).json({ message: 'No se encontraron filas válidas. Use columnas: nombre, dni, empresa, destino, fecha' });
    }

    await batch.commit();
    res.status(200).json({ message: `${count} citaciones cargadas exitosamente`, count });
  } catch (err) {
    res.status(500).json({ message: 'Error al cargar citaciones', error: err.message });
  }
});

app.get('/api/admin/access-control', auth, requirePermission('access.control'), async (_req, res) => {
  try {
    const config = await getAccessControlConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener configuración de acceso', error: err.message });
  }
});

app.put('/api/admin/access-control', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const allowedKeys = Object.keys(DEFAULT_ACCESS_CONTROL);
    const updates = {};
    allowedKeys.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    await db.collection('settings').doc('accessControl').set(updates, { merge: true });
    const config = await getAccessControlConfig();
    res.json({ message: 'Configuración de acceso actualizada', config });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar configuración de acceso', error: err.message });
  }
});

app.post('/api/access/test-relay', auth, requirePermission('access.control'), async (_req, res) => {
  try {
    const config = await getAccessControlConfig();
    if (!config.enabled) {
      return res.status(400).json({ message: 'Habilite el control de acceso antes de probar el relevador' });
    }
    const relay = await triggerRelay(config);
    res.json({ message: 'Pulso de prueba enviado al SR201', relay });
  } catch (err) {
    res.status(500).json({ message: 'Error al probar relevador SR201', error: err.message });
  }
});

app.post('/api/access/validar', auth, async (req, res) => {
  try {
    const {
      dni = '',
      nombre = '',
      apellido = '',
      tipoMovimiento = 'ingreso',
      channel = 'molinete',
      guardId = null
    } = req.body;

    const result = await validarAcceso({
      dni,
      nombre,
      apellido,
      tipoMovimiento,
      channel,
      guardId: guardId || req.user?.id || null
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al validar acceso', error: err.message });
  }
});

app.get('/api/guard/access-status', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const result = await checkAccessStatus({
      dni: req.query.dni || req.query.idNumber || '',
      name: req.query.name || ''
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar acceso', error: err.message });
  }
});

app.post('/api/guard/pre-register', auth, requirePermission('master.citaciones.preregister'), async (req, res) => {
  try {
    const authorization = await preRegisterVisitor(req.body, {
      userId: req.user.id,
      username: req.user.username
    });
    res.status(201).json({ message: 'Visita pre-registrada', authorization });
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Error al pre-registrar' });
  }
});

app.post('/api/guard/exceptional-entry', auth, requirePermission('access.exceptional_entry'), async (req, res) => {
  try {
    const result = await registerExceptionalEntry(req.body, {
      userId: req.user.id,
      username: req.user.username
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 400).json({ message: err.message || 'Error en ingreso excepcional' });
  }
});

app.get('/api/guard/fleet-gps/alerts', auth, requirePermission('fleet.gps.read'), async (req, res) => {
  try {
    const result = await fetchNearbyFleetAlerts(db, FieldValue, { userId: req.user.id });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar GPS de flota', error: err.message });
  }
});

app.get('/api/admin/fleet-gps', auth, requirePermission('access.control'), async (_req, res) => {
  try {
    const config = await getFleetGpsConfig(db);
    res.json({ config: publicFleetGpsConfig(config) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener config GPS', error: err.message });
  }
});

app.put('/api/admin/fleet-gps', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const config = await saveFleetGpsConfig(db, FieldValue, req.body || {});
    res.json({ message: 'Configuración GPS UBIKA guardada', config: publicFleetGpsConfig(config) });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar config GPS', error: err.message });
  }
});

app.post('/api/admin/fleet-gps/test', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const result = await fetchNearbyFleetAlerts(db, FieldValue, {
      force: true,
      includeNearest: true,
      userId: req.user.id,
      skipAutoRegister: req.body?.skipAutoRegister !== false
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al probar GPS UBIKA', error: err.message });
  }
});

app.get('/api/admin/nomina', auth, requirePermission('master.nomina.read'), async (_req, res) => {
  try {
    const personal = await listNominaPersonal();
    res.json({ personal, count: personal.length });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar nómina', error: err.message });
  }
});

app.post('/api/admin/nomina/upload', auth, requirePermission('master.nomina.write'), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de filas de nómina' });
    }
    const result = await importNominaRows(data, { importedBy: req.user.id });
    let message = `Nómina importada: ${result.imported} empleados (${result.created} nuevos, ${result.updated} actualizados)`;
    if (result.skipped > 0) {
      message += `. ${result.skipped} filas omitidas`;
    }
    if (result.imported === 0 && result.total > 0) {
      message += '. Revise la columna "Tipo de autorización" del Excel o vuelva a exportar la planilla';
    }
    res.status(200).json({
      message,
      ...result
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al importar nómina', error: err.message });
  }
});

app.get('/api/guard/attendance/missing', auth, requirePermission('attendance.alerts.read'), async (_req, res) => {
  try {
    const result = await getMissingAttendanceAlerts();
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar faltantes de ingreso', error: err.message });
  }
});

app.post('/api/guard/attendance/dismiss', auth, requirePermission('attendance.alerts.read'), async (req, res) => {
  try {
    const { personId, legajoNormalized, idNumberNormalized, name, reason } = req.body || {};
    const result = await dismissAttendanceAlert({
      personId,
      legajoNormalized,
      idNumberNormalized,
      name,
      reason,
      guardId: req.user.id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al omitir alerta', error: err.message });
  }
});

app.post('/api/guard/attendance/register-entry', auth, requirePermission('entries.create'), async (req, res) => {
  try {
    const {
      name,
      idNumber,
      legajo,
      company,
      destination,
      eventTime,
      movementType = 'ingreso'
    } = req.body || {};

    if (!name?.trim()) {
      return res.status(400).json({ message: 'El nombre es obligatorio' });
    }

    const entryData = {
      type: 'personal',
      movementType,
      name: name.trim(),
      idNumber: idNumber || legajo || '',
      company: company || '',
      destination: destination || '',
      entrySource: 'attendance_alert',
      eventTime: eventTime || null,
      registeredBy: req.user.id,
      timestamp: Timestamp.now(),
      attendanceAlert: true
    };

    const ref = await db.collection('entries').add(entryData);

    if (movementType === 'ingreso') {
      const accessResult = await triggerAccessIfAuthorized({
        movementType,
        idNumber: idNumber || legajo,
        name,
        entrySource: 'attendance_alert',
        entryId: ref.id,
        username: req.user.id,
        allowManualOverride: true
      });
      await ref.update({
        accessAuthorized: accessResult.authorized,
        accessReason: accessResult.reason,
        authorizationType: accessResult.authorizationType,
        relayTriggered: Boolean(accessResult.relay?.triggered),
        relayError: accessResult.relay?.error || null
      });
    }

    res.status(201).json({
      message: 'Ingreso registrado desde alerta de asistencia',
      entryId: ref.id
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar ingreso', error: err.message });
  }
});

app.post('/api/guard/attendance/bulk-present', auth, requirePermission('entries.create'), async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ message: 'Se requiere al menos un colaborador' });
    }
    if (items.length > 100) {
      return res.status(400).json({ message: 'Máximo 100 colaboradores por operación' });
    }

    let registered = 0;
    const errors = [];

    for (const item of items) {
      if (!item?.name?.trim()) {
        errors.push({ name: item?.name || '—', reason: 'nombre_vacio' });
        continue;
      }
      try {
        const entryData = {
          type: 'personal',
          movementType: 'ingreso',
          name: item.name.trim(),
          idNumber: item.idNumber || item.legajo || '',
          company: item.centroCosto || item.company || '',
          destination: item.centroCosto || item.destination || '',
          entrySource: 'attendance_alert',
          registeredBy: req.user.id,
          timestamp: Timestamp.now(),
          attendanceAlert: true,
          bulkAttendance: true
        };
        await db.collection('entries').add(entryData);
        registered += 1;
      } catch (err) {
        errors.push({ name: item.name, reason: err.message });
      }
    }

    res.status(200).json({
      message: `${registered} ingreso(s) registrado(s)`,
      registered,
      errors
    });
  } catch (err) {
    res.status(500).json({ message: 'Error en registro masivo', error: err.message });
  }
});

app.post('/api/guard/attendance/bulk-absent', auth, requirePermission('attendance.alerts.read'), async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ message: 'Se requiere al menos un colaborador' });
    }
    if (items.length > 100) {
      return res.status(400).json({ message: 'Máximo 100 colaboradores por operación' });
    }
    const result = await bulkDismissAttendance(items, {
      guardId: req.user.id,
      reason: req.body?.reason || 'ausente_guardia'
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al marcar ausentes', error: err.message });
  }
});

app.post('/api/access/kiosk-scan', auth, async (req, res) => {
  try {
    const { rawData } = req.body;
    if (!rawData?.trim()) {
      return res.status(400).json({ message: 'Datos de escaneo vacíos' });
    }

    const result = await processKioskScan({
      rawData,
      username: req.user.id
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error en control de acceso', error: err.message });
  }
});

app.post('/api/access/evaluate', auth, requirePermission('master.personal.read'), async (req, res) => {
  try {
    const { idNumber, movementType = 'ingreso', entrySource = 'scan', name = '' } = req.body;
    const access = await evaluatePersonalAccess({ idNumber, movementType, entrySource, name });
    res.json({
      access: {
        authorized: access.authorized,
        reason: access.reason,
        authorizationType: access.authorizationType,
        authorizationLabel: access.authorizationLabel,
        message: access.message,
        displayName: access.displayName,
        hasAuthorization: Boolean(access.authorization)
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al evaluar acceso', error: err.message });
  }
});

app.post('/api/scan/resolve', auth, requirePermission('master.personal.read'), async (req, res) => {
  try {
    const { rawData } = req.body;
    if (!rawData?.trim()) {
      return res.status(400).json({ message: 'Datos de escaneo vacíos' });
    }

    const parsed = parseScanData(rawData);
    const idNumber = normalizeIdNumber(parsed.idNumber);
    let personal = null;
    let source = 'manual';

    if (idNumber) {
      const personalSnap = await db.collection('personalMaster')
        .where('idNumberNormalized', '==', idNumber)
        .limit(1)
        .get();
      if (!personalSnap.empty) {
        const doc = personalSnap.docs[0];
        personal = { id: doc.id, ...doc.data() };
        source = 'master';
      }
    }

    const resolvedName = parsed.name || buildResolvedName(parsed);
    const authorization = idNumber ? await resolveAuthorization(idNumber) : null;
    if (authorization) source = authorization.reason || authorization.type;

    const resolved = {
      idNumber,
      name: authorization?.name || personal?.name || resolvedName,
      company: authorization?.company || personal?.company || parsed.company || '',
      destination: authorization?.destination || personal?.destination || parsed.destination || '',
      source,
      scanFormat: parsed.format || 'unknown',
      hasCitacion: authorization?.type === 'citacion',
      hasAuthorization: Boolean(authorization),
      rawData: parsed.rawData || rawData.trim()
    };

    if (!resolved.name && !resolved.idNumber) {
      return res.status(404).json({ message: 'No se pudo interpretar el escaneo', rawData: rawData.trim() });
    }

    const access = await evaluatePersonalAccess({
      idNumber: resolved.idNumber,
      name: resolved.name,
      movementType: 'ingreso',
      entrySource: source === 'manual' ? 'manual' : 'scan'
    });

    res.json({
      resolved,
      personal,
      authorization,
      citacion: authorization?.type === 'citacion' ? authorization : null,
      access: {
        authorized: access.authorized,
        reason: access.reason,
        authorizationType: access.authorizationType,
        authorizationLabel: access.authorizationLabel,
        message: access.message
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al resolver escaneo', error: err.message });
  }
});

const buildResolvedName = (parsed) => {
  if (parsed.name) return parsed.name;
  return [parsed.firstName, parsed.lastName].filter(Boolean).join(' ').trim();
};

app.get('/api/master-data/vehicles', auth, requirePermission('master.vehicles.read'), async (_req, res) => {
  try {
    const snap = await db.collection('vehiclesMaster').orderBy('plate').get();
    res.json({ vehicles: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener vehículos autorizados', error: err.message });
  }
});

app.get('/api/master-data/vehicles/lookup', auth, requirePermission('master.vehicles.read'), async (req, res) => {
  try {
    const plateNormalized = normalizePlate(req.query.plate || '');
    if (!plateNormalized) {
      return res.status(400).json({ message: 'Patente inválida' });
    }

    const snap = await db.collection('vehiclesMaster')
      .where('plateNormalized', '==', plateNormalized)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.json({
        authorized: false,
        plate: req.query.plate,
        message: 'Vehículo no precargado',
        vehicle: null,
        driverAccess: null
      });
    }

    const vehicle = { id: snap.docs[0].id, ...snap.docs[0].data() };
    let driverAccess = null;
    if (vehicle.driver?.trim()) {
      driverAccess = await checkAccessStatus({
        dni: vehicle.driverDni || vehicle.driverIdNumber || '',
        name: vehicle.driver
      });
    }

    res.json({
      authorized: vehicle.authorized !== false,
      vehicle,
      driverAccess,
      message: vehicle.authorized !== false ? 'Vehículo autorizado' : 'Vehículo registrado pero no autorizado',
      driverMessage: driverAccess
        ? (driverAccess.authorized
          ? `Conductor habilitado (${driverAccess.authorizationType || 'ok'})`
          : 'Conductor sin autorización vigente')
        : null
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar patente', error: err.message });
  }
});

app.post('/api/master-data/vehicles', auth, requirePermission('master.vehicles.write'), async (req, res) => {
  try {
    const { plate, brand, company, driver, authorized = true, notes } = req.body;
    const plateNormalized = normalizePlate(plate);
    if (!plateNormalized) {
      return res.status(400).json({ message: 'La patente es obligatoria' });
    }

    const existing = await db.collection('vehiclesMaster')
      .where('plateNormalized', '==', plateNormalized)
      .limit(1)
      .get();

    const vehicleData = {
      plate: plate.trim(),
      plateNormalized,
      brand: brand?.trim() || '',
      company: company?.trim() || '',
      driver: driver?.trim() || '',
      authorized: authorized !== false,
      notes: notes?.trim() || '',
      updatedAt: FieldValue.serverTimestamp()
    };

    let vehicleRef;
    if (!existing.empty) {
      vehicleRef = existing.docs[0].ref;
      await vehicleRef.update(vehicleData);
    } else {
      vehicleRef = db.collection('vehiclesMaster').doc();
      await vehicleRef.set({ ...vehicleData, createdAt: FieldValue.serverTimestamp() });
    }

    res.status(201).json({
      message: 'Vehículo guardado en la base autorizada',
      vehicle: { id: vehicleRef.id, ...vehicleData }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar vehículo autorizado', error: err.message });
  }
});

app.post('/api/master-data/vehicles/quick-authorize', auth, requirePermission('master.vehicles.quick_authorize'), async (req, res) => {
  try {
    const { plate, brand, company, driver } = req.body;
    const plateNormalized = normalizePlate(plate);
    if (!plateNormalized) {
      return res.status(400).json({ message: 'La patente es obligatoria' });
    }

    const existing = await db.collection('vehiclesMaster')
      .where('plateNormalized', '==', plateNormalized)
      .limit(1)
      .get();

    const vehicleData = {
      plate: plate.trim(),
      plateNormalized,
      brand: brand?.trim() || '',
      company: company?.trim() || '',
      driver: driver?.trim() || '',
      authorized: true,
      authorizedBy: req.user.id,
      authorizedAt: FieldValue.serverTimestamp(),
      notes: 'Autorización rápida en guardia'
    };

    let vehicleRef;
    if (!existing.empty) {
      vehicleRef = existing.docs[0].ref;
      await vehicleRef.update(vehicleData);
    } else {
      vehicleRef = db.collection('vehiclesMaster').doc();
      await vehicleRef.set({ ...vehicleData, createdAt: FieldValue.serverTimestamp() });
    }

    res.status(201).json({
      message: 'Vehículo autorizado correctamente',
      vehicle: { id: vehicleRef.id, ...vehicleData }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error en autorización rápida', error: err.message });
  }
});

app.delete('/api/master-data/vehicles/:id', auth, requirePermission('master.vehicles.write'), async (req, res) => {
  try {
    const ref = db.collection('vehiclesMaster').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Vehículo no encontrado' });
    }
    await ref.delete();
    res.json({ message: 'Vehículo eliminado de la base autorizada' });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar vehículo', error: err.message });
  }
});

app.post('/api/admin/fleet/vehicles/upload', auth, requirePermission('master.vehicles.write'), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de vehículos' });
    }

    const batch = db.batch();
    data.forEach((item) => {
      const plateNormalized = normalizePlate(item.plate || item.patente || '');
      if (!plateNormalized) return;
      const ref = db.collection('vehiclesMaster').doc();
      batch.set(ref, {
        plate: (item.plate || item.patente || '').trim(),
        plateNormalized,
        brand: (item.brand || item.marca || '').trim(),
        company: (item.company || item.empresa || '').trim(),
        driver: (item.driver || item.conductor || '').trim(),
        authorized: item.authorized !== false,
        notes: (item.notes || item.observaciones || '').trim(),
        createdAt: FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    res.status(200).json({ message: 'Vehículos autorizados cargados exitosamente.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al cargar vehículos autorizados', error: err.message });
  }
});

app.post('/api/entries', auth, async (req, res) => {
  try {
    const {
      type, movementType, eventTime, name, idNumber, company, destination,
      plate, brand, driver, description, mobile, flotaDriver, scheduledTime, actualTime,
      entrySource, authorized, authorizedStatus, allowAccessOverride, exceptionalReason
    } = req.body;

    const validationError = validateEntryPayload(type, req.body);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const entryData = {
      type,
      registeredBy: req.user.id,
      timestamp: Timestamp.now(),
      eventTime: eventTime || null
    };

    if (type === 'personal') {
      Object.assign(entryData, {
        movementType,
        name,
        idNumber,
        company,
        destination,
        entrySource: entrySource || 'manual'
      });
    } else if (type === 'vehiculo') {
      Object.assign(entryData, {
        movementType,
        plate,
        brand,
        company,
        driver,
        authorized: authorized === true,
        authorizedStatus: authorizedStatus || (authorized ? 'authorized' : 'not_authorized')
      });
    } else if (type === 'flota') {
      Object.assign(entryData, { movementType, mobile, flotaDriver, scheduledTime, actualTime });
    } else if (type === 'novedad') {
      Object.assign(entryData, { description });
    }

    const ref = await db.collection('entries').add(entryData);
    const saved = await ref.get();

    let accessResult = null;
    if (type === 'personal') {
      const userSnap = await db.collection('users').doc(req.user.id).get();
      const userPermissions = userSnap.exists ? await getUserPermissions(userSnap.data()) : [];
      const manualOverrideAllowed = userPermissions.includes('access.manual_override') || req.user.role === 'admin';
      const exceptionalAllowed = userPermissions.includes('access.exceptional_entry') || req.user.role === 'admin';
      const useExceptional = Boolean(exceptionalReason?.trim()) && exceptionalAllowed;

    accessResult = await triggerAccessIfAuthorized({
      movementType,
      idNumber,
      name,
      entrySource: entrySource || 'manual',
      entryId: ref.id,
      username: req.user.id,
      allowManualOverride: useExceptional
        ? true
        : (allowAccessOverride === true ? true : (entrySource === 'manual' ? manualOverrideAllowed : null))
    });

      const accessPatch = {
        accessAuthorized: useExceptional ? true : accessResult.authorized,
        accessReason: useExceptional ? 'ingreso_excepcional' : accessResult.reason,
        authorizationType: useExceptional ? 'ingreso_excepcional' : accessResult.authorizationType,
        relayTriggered: Boolean(accessResult.relay?.triggered),
        relayError: accessResult.relay?.error || null
      };
      if (useExceptional) {
        accessPatch.exceptionalEntry = true;
        accessPatch.exceptionalReason = exceptionalReason.trim();
        accessPatch.notes = `Ingreso excepcional: ${exceptionalReason.trim()}`;
      }

      await ref.update(accessPatch);
    }

    res.status(201).json({
      message: 'Entrada creada exitosamente',
      entry: { id: ref.id, ...saved.data(), ...(type === 'personal' ? {
        accessAuthorized: accessResult?.authorized,
        accessReason: accessResult?.reason,
        relayTriggered: accessResult?.relay?.triggered
      } : {}) },
      ...(accessResult ? { access: accessResult } : {})
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear entrada', error: err.message });
  }
});

app.get('/api/entries', auth, async (_req, res) => {
  try {
    const snap = await db.collection('entries').orderBy('timestamp', 'desc').get();
    const userIds = [...new Set(snap.docs.map((doc) => doc.data().registeredBy).filter(Boolean))];

    const usernames = {};
    await Promise.all(userIds.map(async (userId) => {
      const userSnap = await db.collection('users').doc(userId).get();
      usernames[userId] = userSnap.exists ? userSnap.data().username : 'Desconocido';
    }));

    const entries = snap.docs.map((doc) =>
      entryToJSON(doc, usernames[doc.data().registeredBy] || 'Desconocido')
    );

    res.json({ entries });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener entradas', error: err.message });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Ruta no encontrada' });
  }
  next();
});

module.exports = app;
