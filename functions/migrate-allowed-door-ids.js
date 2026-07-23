/**
 * Migración: allowedDoorIds vacío/ausente → lista explícita de TODAS las puertas activas.
 *
 * Motivo: el criterio nuevo trata null/[] como "ninguna puerta". Antes de activarlo,
 * hay que materializar el acceso implícito ("todas") como lista explícita, para que
 * nadie pierda el acceso que ya tenía (p.ej. molinete Bacar en producción).
 *
 * Colecciones: people, authorizations, visitas
 *
 * Uso (desde functions/):
 *   node migrate-allowed-door-ids.js --dry-run
 *   node migrate-allowed-door-ids.js --apply
 *
 * Requiere: functions/serviceAccountKey.json
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const keyPath = path.join(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(keyPath)) {
  console.error('Falta functions/serviceAccountKey.json');
  process.exit(1);
}

if (!admin.apps.length) {
  const serviceAccount = require(keyPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });
}

const db = admin.firestore();
const write = process.argv.includes('--apply') && !process.argv.includes('--dry-run');

const needsMigration = (data = {}) => {
  const value = data.allowedDoorIds;
  if (value == null) return true;
  if (!Array.isArray(value)) return true;
  return value.map((id) => String(id || '').trim()).filter(Boolean).length === 0;
};

const labelOf = (data = {}, id) => {
  const name = data.nombre || data.name || data.nombreVisitante || data.credentialCode || '';
  const dni = data.dniNormalized || data.idNumberNormalized || data.dni
    || data.dniVisitanteNormalized || data.dniVisitante || '';
  return [id, name, dni].filter(Boolean).join(' · ');
};

const getActiveDoorIds = async () => {
  const snap = await db.collection('settings').doc('doorsConfig').get();
  const doors = snap.exists ? (snap.data().doors || []) : [];
  return doors
    .filter((d) => d && d.active !== false && d.id)
    .map((d) => String(d.id).trim())
    .filter(Boolean);
};

const scanCollection = async (collectionName) => {
  const snap = await db.collection(collectionName).get();
  const toUpdate = [];
  let alreadySet = 0;
  let skippedInactive = 0;

  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (collectionName === 'people' && data.active === false) {
      skippedInactive += 1;
      return;
    }
    if (collectionName === 'authorizations' && data.active === false) {
      skippedInactive += 1;
      return;
    }
    if (!needsMigration(data)) {
      alreadySet += 1;
      return;
    }
    toUpdate.push({
      id: doc.id,
      ref: doc.ref,
      label: labelOf(data, doc.id),
      before: data.allowedDoorIds ?? null
    });
  });

  return {
    collection: collectionName,
    total: snap.size,
    alreadySet,
    skippedInactive,
    toUpdate,
    sample: toUpdate.slice(0, 15).map((row) => ({
      id: row.id,
      label: row.label,
      before: row.before
    }))
  };
};

const applyUpdates = async (rows, allDoorIds) => {
  const BATCH_LIMIT = 400;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_LIMIT) {
    const chunk = rows.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach((row) => {
      batch.update(row.ref, {
        allowedDoorIds: allDoorIds,
        allowedDoorIdsMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    written += chunk.length;
    console.log(`  … escritos ${written}/${rows.length}`);
  }
  return written;
};

async function main() {
  console.log('=== migrate-allowed-door-ids ===');
  console.log(`Modo: ${write ? 'APPLY (escribe Firestore)' : 'DRY-RUN (solo lectura)'}`);
  console.log('');

  const allDoorIds = await getActiveDoorIds();
  if (!allDoorIds.length) {
    console.error('No hay puertas activas en settings/doorsConfig. Abortando.');
    process.exit(1);
  }

  console.log(`Puertas activas (${allDoorIds.length}):`);
  allDoorIds.forEach((id) => console.log(`  - ${id}`));
  console.log('');

  const reports = [];
  for (const name of ['people', 'authorizations', 'visitas']) {
    reports.push(await scanCollection(name));
  }

  let grandTotal = 0;
  for (const r of reports) {
    grandTotal += r.toUpdate.length;
    console.log(`── ${r.collection} ──`);
    console.log(`  docs totales:             ${r.total}`);
    console.log(`  ya con lista explícita:   ${r.alreadySet}`);
    console.log(`  omitidos (inactivos):     ${r.skippedInactive}`);
    console.log(`  A MIGRAR (vacío/ausente): ${r.toUpdate.length}`);
    if (r.sample.length) {
      console.log('  muestra (hasta 15):');
      r.sample.forEach((s) => {
        console.log(`    • ${s.label}  [before=${JSON.stringify(s.before)}]`);
      });
    }
    console.log('');
  }

  console.log(`TOTAL a migrar: ${grandTotal} documentos → allowedDoorIds = ${JSON.stringify(allDoorIds)}`);
  console.log('');

  if (!write) {
    console.log('DRY-RUN terminado. No se escribió nada.');
    console.log('Para aplicar: node migrate-allowed-door-ids.js --apply');
    process.exit(0);
  }

  console.log('Aplicando migración…');
  for (const r of reports) {
    if (!r.toUpdate.length) continue;
    console.log(`Escribiendo ${r.collection} (${r.toUpdate.length})…`);
    await applyUpdates(r.toUpdate, allDoorIds);
  }
  console.log('');
  console.log(`APPLY OK. Migrados ${grandTotal} documentos.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
