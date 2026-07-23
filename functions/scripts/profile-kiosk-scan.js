/**
 * Perfil local de processKioskScan contra Firestore de producción.
 * Uso: node scripts/profile-kiosk-scan.js [dni] [doorId]
 */
const path = require('path');
const fs = require('fs');

const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error('Falta serviceAccountKey.json');
  process.exit(1);
}

const admin = require('firebase-admin');
const sa = require(keyPath);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
}

// Asegurar que accessControl use el mismo firestore que ya inicializamos
const firestorePath = require.resolve('../firestore');
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    db: admin.firestore(),
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp
  }
};

const { processKioskScan } = require('../accessControl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dniArg = process.argv[2];
  const doorId = process.argv[3] || 'puerta-p1';

  let dni = dniArg;
  let nombre = '';
  if (!dni) {
    const snap = await admin.firestore().collection('people')
      .where('active', '==', true)
      .limit(20)
      .get();
    const withDni = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .find((p) => p.dniNormalized && String(p.dniNormalized).length >= 7);
    if (!withDni) {
      console.error('No encontré persona con DNI para probar');
      process.exit(1);
    }
    dni = withDni.dniNormalized;
    nombre = withDni.nombre || withDni.name || '';
    console.log('Usando persona de prueba:', { id: withDni.id, nombre, dni, doors: withDni.allowedDoorIds });
  }

  const rawData = String(dni);

  for (let i = 1; i <= 2; i += 1) {
    console.log(`\n========== RUN ${i} ==========`);
    const t0 = Date.now();
    const result = await processKioskScan({
      rawData,
      username: 'profile-script',
      doorId,
      readerId: 'INGRESO_P1'
    });
    console.log('HTTP-equivalent wallMs:', Date.now() - t0);
    console.log('result:', {
      authorized: result.authorized,
      movementType: result.movementType,
      relayMode: result.relayMode,
      message: result.message,
      denialReason: result.denialReason,
      personId: result.personId,
      entryId: result.entryId
    });
    if (i === 1) await sleep(3000);
  }

  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
