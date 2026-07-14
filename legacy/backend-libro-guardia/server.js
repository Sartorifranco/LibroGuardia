// backend-libro-guardia/server.js

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5020;
const JWT_SECRET = process.env.JWT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;

if (!JWT_SECRET || !MONGODB_URI) {
  console.error('Faltan variables de entorno requeridas: JWT_SECRET y/o MONGODB_URI');
  process.exit(1);
}

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
app.use(express.json());

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Conectado a MongoDB'))
  .catch((err) => console.error('Error al conectar a MongoDB:', err));

// --- Modelos Mongoose ---

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['guardia', 'admin', 'supervisor'], default: 'guardia' },
  active: { type: Boolean, default: true }
});

UserSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

const User = mongoose.model('User', UserSchema);

const MobileSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true }
});
const Mobile = mongoose.model('Mobile', MobileSchema);

const DriverSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true }
});
const Driver = mongoose.model('Driver', DriverSchema);

const PersonalMasterSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  idNumber: { type: String, default: '' },
  company: { type: String, default: '' },
  destination: { type: String, default: '' }
});
const PersonalMaster = mongoose.model('PersonalMaster', PersonalMasterSchema);

const EntrySchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ['personal', 'vehiculo', 'flota', 'novedad'] },
  timestamp: { type: Date, default: Date.now },
  registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  movementType: { type: String, enum: ['ingreso', 'egreso', 'ingreso auxilio', 'egreso auxilio'] },
  eventTime: { type: String },
  name: { type: String },
  idNumber: { type: String },
  company: { type: String },
  destination: { type: String },
  plate: { type: String },
  brand: { type: String },
  driver: { type: String },
  mobile: { type: String },
  flotaDriver: { type: String },
  scheduledTime: { type: Date },
  actualTime: { type: Date },
  description: { type: String }
});

const Entry = mongoose.model('Entry', EntrySchema);

// --- Middleware ---

const auth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ message: 'No token, autorización denegada' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token no válido' });
  }
};

const authorize = (roles = []) => {
  if (typeof roles === 'string') {
    roles = [roles];
  }
  return (req, res, next) => {
    if (!req.user || (roles.length && !roles.includes(req.user.role))) {
      return res.status(403).json({ message: 'Acceso denegado: No tiene los permisos necesarios' });
    }
    next();
  };
};

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

// --- Rutas ---

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Registro público: siempre crea usuarios con rol guardia
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username?.trim() || !password) {
      return res.status(400).json({ message: 'Usuario y contraseña son obligatorios' });
    }
    const user = new User({ username: username.trim(), password, role: 'guardia' });
    await user.save();
    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      user: { id: user._id, username: user.username, role: user.role, active: user.active }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'El nombre de usuario ya existe' });
    }
    res.status(500).json({ message: 'Error al registrar usuario', error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }
    if (!user.active) {
      return res.status(403).json({ message: 'Su cuenta ha sido deshabilitada. Contacte a un administrador.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({
      token,
      user: { id: user._id, username: user.username, role: user.role, active: user.active }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al iniciar sesión', error: err.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    res.json({ user: { id: user._id, username: user.username, role: user.role, active: user.active } });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener datos del usuario', error: err.message });
  }
});

app.post('/api/admin/users', auth, authorize('admin'), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!['guardia', 'admin', 'supervisor'].includes(role)) {
      return res.status(400).json({ message: 'Rol inválido especificado.' });
    }
    const user = new User({ username, password, role });
    await user.save();
    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: { id: user._id, username: user.username, role: user.role, active: user.active }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'El nombre de usuario ya existe' });
    }
    res.status(500).json({ message: 'Error al crear usuario', error: err.message });
  }
});

app.get('/api/admin/users', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json({ users: users.map((u) => ({ id: u._id, username: u.username, role: u.role, active: u.active })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener usuarios', error: err.message });
  }
});

app.put('/api/admin/users/:id', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const { id } = req.params;
    const { role, password, active } = req.body;

    const userToUpdate = await User.findById(id);
    if (!userToUpdate) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    if (req.user.role === 'admin') {
      if (role) {
        if (!['guardia', 'admin', 'supervisor'].includes(role)) {
          return res.status(400).json({ message: 'Rol inválido' });
        }
        userToUpdate.role = role;
      }
      if (password) userToUpdate.password = password;
      if (typeof active === 'boolean') userToUpdate.active = active;
    } else if (req.user.role === 'supervisor') {
      if (userToUpdate.role !== 'guardia') {
        return res.status(403).json({ message: 'Acceso denegado: Un supervisor solo puede editar usuarios con rol "guardia".' });
      }
      if (role && userToUpdate.role !== role) {
        return res.status(403).json({ message: 'Acceso denegado: Un supervisor no puede cambiar el rol de un usuario.' });
      }
      if (password) userToUpdate.password = password;
      if (typeof active === 'boolean') userToUpdate.active = active;
    } else {
      return res.status(403).json({ message: 'Acceso denegado: No tiene permisos para editar usuarios.' });
    }

    await userToUpdate.save();
    res.json({
      message: 'Usuario actualizado',
      user: { id: userToUpdate._id, username: userToUpdate.username, role: userToUpdate.role, active: userToUpdate.active }
    });
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

    const userToDelete = await User.findById(id);
    if (!userToDelete) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    if (req.user.role === 'admin') {
      await User.findByIdAndDelete(id);
    } else if (req.user.role === 'supervisor') {
      if (userToDelete.role !== 'guardia') {
        return res.status(403).json({ message: 'Acceso denegado: Un supervisor solo puede eliminar usuarios con rol "guardia".' });
      }
      await User.findByIdAndDelete(id);
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

    const normalized = data.map((item) => ({ name: item.name.trim() }));
    await Mobile.deleteMany({});
    await Mobile.insertMany(normalized);

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

    const normalized = data.map((item) => ({ name: item.name.trim() }));
    await Driver.deleteMany({});
    await Driver.insertMany(normalized);

    res.status(200).json({ message: 'Lista de choferes actualizada exitosamente.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir la lista de choferes', error: err.message });
  }
});

app.get('/api/fleet/mobiles', auth, async (req, res) => {
  try {
    const mobiles = await Mobile.find({}).sort({ name: 1 });
    res.json({ mobiles });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener móviles', error: err.message });
  }
});

app.get('/api/fleet/drivers', auth, async (req, res) => {
  try {
    const drivers = await Driver.find({}).sort({ name: 1 });
    res.json({ drivers });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener choferes', error: err.message });
  }
});

// Datos maestros de personal (autocompletado)
app.get('/api/master-data/personal', auth, async (_req, res) => {
  try {
    const personal = await PersonalMaster.find({}).sort({ name: 1 });
    res.json({ personal });
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
    let person = await PersonalMaster.findOne({
      name: { $regex: new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });

    if (person) {
      person.idNumber = idNumber || person.idNumber;
      person.company = company || person.company;
      person.destination = destination || person.destination;
      await person.save();
    } else {
      person = await PersonalMaster.create({
        name: normalizedName,
        idNumber: idNumber || '',
        company: company || '',
        destination: destination || ''
      });
    }

    res.status(201).json({ message: 'Persona guardada en la base maestra', personal: person });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Ya existe una persona con ese nombre' });
    }
    res.status(500).json({ message: 'Error al guardar persona en la base maestra', error: err.message });
  }
});

app.post('/api/entries', auth, async (req, res) => {
  try {
    const {
      type, movementType, eventTime, name, idNumber, company, destination,
      plate, brand, driver, description, mobile, flotaDriver, scheduledTime, actualTime
    } = req.body;

    const validationError = validateEntryPayload(type, req.body);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const newEntry = new Entry({
      type,
      registeredBy: req.user.id,
      timestamp: new Date(),
      eventTime: eventTime || undefined
    });

    if (type === 'personal') {
      Object.assign(newEntry, { movementType, name, idNumber, company, destination });
    } else if (type === 'vehiculo') {
      Object.assign(newEntry, { movementType, plate, brand, company, driver });
    } else if (type === 'flota') {
      Object.assign(newEntry, { movementType, mobile, flotaDriver, scheduledTime, actualTime });
    } else if (type === 'novedad') {
      Object.assign(newEntry, { description });
    }

    await newEntry.save();
    res.status(201).json({ message: 'Entrada creada exitosamente', entry: newEntry });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear entrada', error: err.message });
  }
});

app.get('/api/entries', auth, async (req, res) => {
  try {
    const entries = await Entry.find().sort({ timestamp: -1 }).populate('registeredBy', 'username');
    const formattedEntries = entries.map((entry) => ({
      ...entry.toObject(),
      registeredByUsername: entry.registeredBy ? entry.registeredBy.username : 'Desconocido'
    }));
    res.json({ entries: formattedEntries });
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

app.listen(PORT, () => {
  console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
});
