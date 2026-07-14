/**
 * Auditoría de datos históricos en Mongo legacy (solo lectura).
 *
 * Uso en la PC/servidor que tenga acceso al Mongo de planta:
 *   cd legacy/backend-libro-guardia
 *   # asegurar MONGODB_URI en .env
 *   node ../../scripts/audit-mongo-legacy.js
 *
 * No migra ni borra nada.
 */

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', 'legacy', 'backend-libro-guardia', '.env');
if (fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  });
}

const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  if (!MONGODB_URI) {
    console.error('Falta MONGODB_URI. Colocalo en legacy/backend-libro-guardia/.env o en el entorno.');
    process.exit(2);
  }

  let MongoClient;
  try {
    ({ MongoClient } = require(path.join(
      __dirname,
      '..',
      'legacy',
      'backend-libro-guardia',
      'node_modules',
      'mongodb'
    )));
  } catch {
    try {
      ({ MongoClient } = require('mongodb'));
    } catch {
      console.error('Instalá mongodb en legacy/backend-libro-guardia (npm i) e intentá de nuevo.');
      process.exit(2);
    }
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  const collections = await db.listCollections().toArray();
  const report = [];

  for (const col of collections) {
    const name = col.name;
    const coll = db.collection(name);
    const count = await coll.countDocuments();
    let oldest = null;
    let newest = null;
    const dateFields = ['_id', 'timestamp', 'createdAt', 'updatedAt', 'date'];
    for (const field of dateFields) {
      try {
        const asc = await coll.find({ [field]: { $exists: true } }).sort({ [field]: 1 }).limit(1).toArray();
        const desc = await coll.find({ [field]: { $exists: true } }).sort({ [field]: -1 }).limit(1).toArray();
        if (asc[0]) {
          const v = field === '_id' ? asc[0]._id.getTimestamp?.() || asc[0]._id : asc[0][field];
          oldest = v instanceof Date ? v.toISOString() : String(v);
        }
        if (desc[0]) {
          const v = field === '_id' ? desc[0]._id.getTimestamp?.() || desc[0]._id : desc[0][field];
          newest = v instanceof Date ? v.toISOString() : String(v);
        }
        if (oldest || newest) break;
      } catch {
        // campo no indexable / vacío
      }
    }
    report.push({ collection: name, count, oldest, newest });
  }

  console.log(JSON.stringify({ database: db.databaseName, generatedAt: new Date().toISOString(), collections: report }, null, 2));
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
