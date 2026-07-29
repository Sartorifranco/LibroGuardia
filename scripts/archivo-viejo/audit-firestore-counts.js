/**
 * Cuenta documentos en colecciones Firestore relevantes (solo lectura).
 *
 * Uso:
 *   cd functions
 *   node ../scripts/audit-firestore-counts.js
 *
 * Requiere GOOGLE_APPLICATION_CREDENTIALS o functions/serviceAccountKey.json
 */

const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

const keyPath = path.join(__dirname, '..', 'functions', 'serviceAccountKey.json');
if (!admin.apps.length) {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const sa = require(keyPath);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

const db = admin.firestore();

const COLLECTIONS = [
  'users',
  'entries',
  'personalMaster',
  'vehiclesMaster',
  'people',
  'authorizations',
  'citaciones',
  'roles',
  'accessEvents',
  'mobiles',
  'drivers',
  'nominaImports',
  'citacionesImports'
];

async function countCollection(name) {
  try {
    const agg = await db.collection(name).count().get();
    return agg.data().count;
  } catch (err) {
    // fallback para entornos sin count aggregation
    const snap = await db.collection(name).select().limit(5000).get();
    return snap.size >= 5000 ? `${snap.size}+` : snap.size;
  }
}

async function dateBounds(name, fieldCandidates = ['timestamp', 'createdAt', 'updatedAt']) {
  for (const field of fieldCandidates) {
    try {
      const oldest = await db.collection(name).orderBy(field, 'asc').limit(1).get();
      const newest = await db.collection(name).orderBy(field, 'desc').limit(1).get();
      if (!oldest.empty && !newest.empty) {
        const o = oldest.docs[0].data()[field];
        const n = newest.docs[0].data()[field];
        return {
          field,
          oldest: o?.toDate?.()?.toISOString?.() || String(o),
          newest: n?.toDate?.()?.toISOString?.() || String(n)
        };
      }
    } catch {
      // sin índice / campo
    }
  }
  return { field: null, oldest: null, newest: null };
}

async function main() {
  const rows = [];
  for (const name of COLLECTIONS) {
    try {
      const count = await countCollection(name);
      const bounds = await dateBounds(name);
      rows.push({ collection: name, count, ...bounds });
      console.error(`OK ${name}: ${count}`);
    } catch (err) {
      rows.push({ collection: name, count: null, error: err.message });
      console.error(`ERR ${name}: ${err.message}`);
    }
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), collections: rows }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
