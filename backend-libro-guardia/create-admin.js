/**
 * Crear o promover un usuario admin desde consola (sin mongosh).
 *
 * Uso:
 *   node create-admin.js nombre_usuario contraseña
 *   node create-admin.js nombre_usuario contraseña --promote   (si el usuario ya existe)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI;
const username = process.argv[2];
const password = process.argv[3];
const promoteOnly = process.argv.includes('--promote');

if (!MONGODB_URI) {
  console.error('Falta MONGODB_URI en .env');
  process.exit(1);
}

if (!username || !password) {
  console.error('Uso: node create-admin.js <usuario> <contraseña> [--promote]');
  process.exit(1);
}

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

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Conectado a MongoDB');

  const existing = await User.findOne({ username });

  if (existing) {
    existing.role = 'admin';
    existing.active = true;
    if (password) existing.password = password;
    await existing.save();
    console.log(`Usuario "${username}" actualizado (admin, contraseña cambiada).`);
  } else {
    const user = new User({ username, password, role: 'admin' });
    await user.save();
    console.log(`Admin "${username}" creado correctamente.`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
