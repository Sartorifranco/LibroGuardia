/**
 * Crear admin en Firestore desde tu PC.
 *
 * Requisito: descargar clave de cuenta de servicio desde Firebase Console:
 *   Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada
 *   Guardar como: functions/serviceAccountKey.json
 *
 * Uso: node create-admin.js admin MiClave123
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');

const username = process.argv[2];
const password = process.argv[3];
const keyPath = path.join(__dirname, 'serviceAccountKey.json');

if (!username || !password) {
  console.error('Uso: node create-admin.js <usuario> <contraseña>');
  process.exit(1);
}

if (!fs.existsSync(keyPath)) {
  console.error('Falta el archivo serviceAccountKey.json');
  console.error('');
  console.error('Descargalo así:');
  console.error('  1. https://console.firebase.google.com/project/legajosonline-959f6/settings/serviceaccounts/adminsdk');
  console.error('  2. Clic en "Generar nueva clave privada"');
  console.error('  3. Guardá el JSON como: functions/serviceAccountKey.json');
  process.exit(1);
}

const serviceAccount = require(keyPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });
}

const db = admin.firestore();

async function main() {
  const userRef = db.collection('users').doc(username);
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await userRef.get();
  const passwordVersion = existing.exists
    ? (Number(existing.data().passwordVersion) || 1) + 1
    : 1;

  await userRef.set({
    username,
    password: passwordHash,
    role: 'admin',
    active: true,
    passwordVersion,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  console.log(`Admin "${username}" creado/actualizado en Firestore (passwordVersion=${passwordVersion}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
