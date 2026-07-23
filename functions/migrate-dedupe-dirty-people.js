/**
 * Deduplicar docs sucios en `people` generados por el bug histórico del
 * importador de citaciones (fila CSV completa en `legajo`).
 *
 * Uso (desde functions/):
 *   node migrate-dedupe-dirty-people.js              # dry-run
 *   node migrate-dedupe-dirty-people.js --dry-run    # dry-run
 *   node migrate-dedupe-dirty-people.js --apply      # escribe
 *
 * Requiere: functions/serviceAccountKey.json
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { normalizeLegajo } = require('./lib/personMatch');
const {
  looksLikeTransportCsvLine,
  parseTransportCsvLine
} = require('./lib/transportCsvParser');

const keyPath = path.join(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(keyPath)) {
  console.error('Falta functions/serviceAccountKey.json');
  process.exit(1);
}

const write = process.argv.includes('--apply') && !process.argv.includes('--dry-run');

if (!admin.apps.length) {
  const serviceAccount = require(keyPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const BATCH_LIMIT = 400;

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const displayName = (person = {}) =>
  String(person.nombre || person.name || '').trim();

const isCleanName = (name = '') => {
  const n = String(name || '').trim();
  if (!n) return false;
  if (/^Legajo\s+/i.test(n)) return false;
  if (looksLikeTransportCsvLine(n)) return false;
  if (n.includes(',"') || n.includes('","')) return false;
  return true;
};

const isCleanLegajoField = (value = '') => {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (looksLikeTransportCsvLine(raw) || raw.includes(',"') || raw.includes('","')) {
    return false;
  }
  const digits = raw.replace(/\D/g, '');
  return /^\d{1,6}$/.test(digits) && digits === raw.replace(/\D/g, '') && !raw.includes(',');
};

const hasDoorIds = (person = {}) => {
  const doors = person.allowedDoorIds;
  if (!Array.isArray(doors)) return false;
  return doors.map((id) => String(id || '').trim()).filter(Boolean).length > 0;
};

const extractRealLegajo = (person = {}) => {
  const candidates = [
    person.legajoNormalized,
    person.legajo,
    person.nombre,
    person.name
  ].filter((v) => v !== undefined && v !== null && String(v).trim() !== '');

  for (const candidate of candidates) {
    const raw = String(candidate).trim();
    const withoutPrefix = raw.replace(/^Legajo\s+/i, '').trim();

    if (isCleanLegajoField(withoutPrefix) || isCleanLegajoField(raw)) {
      const normalized = normalizeLegajo(withoutPrefix || raw);
      if (/^\d{1,6}$/.test(normalized)) return normalized;
    }

    const parsed = parseTransportCsvLine(withoutPrefix) || parseTransportCsvLine(raw);
    if (parsed?.legajo) {
      const normalized = normalizeLegajo(parsed.legajo);
      if (/^\d{1,6}$/.test(normalized)) return normalized;
    }
  }

  for (const candidate of candidates) {
    const m = String(candidate)
      .replace(/^Legajo\s+/i, '')
      .trim()
      .match(/^"?(\d{3,5})"?,/);
    if (m) {
      const normalized = normalizeLegajo(m[1]);
      if (/^\d{1,6}$/.test(normalized)) return normalized;
    }
  }

  return null;
};

const scoreWinner = (person) => {
  const name = displayName(person);
  const cleanName = isCleanName(name) ? 100 : 0;
  const cleanLegajo = isCleanLegajoField(person.legajoNormalized || person.legajo) ? 50 : 0;
  const doors = hasDoorIds(person) ? 30 : 0;
  const recent = Math.min(toMillis(person.updatedAt || person.createdAt) / 1e12, 20);
  return cleanName + cleanLegajo + doors + recent;
};

const pickWinner = (docs) => {
  const ranked = [...docs].sort((a, b) => {
    const scoreDiff = scoreWinner(b.data) - scoreWinner(a.data);
    if (scoreDiff !== 0) return scoreDiff;
    return toMillis(b.data.updatedAt || b.data.createdAt)
      - toMillis(a.data.updatedAt || a.data.createdAt);
  });
  return ranked[0];
};

const findAmbiguityInGroup = (legajo, docs) => {
  const cleanDocs = docs.filter((d) => isCleanName(displayName(d.data))
    && isCleanLegajoField(d.data.legajoNormalized || d.data.legajo));

  if (cleanDocs.length <= 1) return null;

  const names = new Set(
    cleanDocs.map((d) => displayName(d.data).toLowerCase().replace(/\s+/g, ' '))
  );
  const dnis = new Set(
    cleanDocs
      .map((d) => String(d.data.dniNormalized || d.data.idNumberNormalized || d.data.dni || '').replace(/\D/g, ''))
      .filter(Boolean)
  );

  if (names.size > 1) {
    return {
      reason: 'varios docs limpios con nombres distintos para el mismo legajo',
      legajo,
      names: [...names],
      docIds: cleanDocs.map((d) => d.id)
    };
  }
  if (dnis.size > 1) {
    return {
      reason: 'varios docs limpios con DNI distintos para el mismo legajo',
      legajo,
      dnis: [...dnis],
      docIds: cleanDocs.map((d) => d.id)
    };
  }
  return null;
};

const summarizePerson = (doc) => {
  const p = doc.data;
  return {
    id: doc.id,
    nombre: displayName(p).slice(0, 80),
    legajoField: String(p.legajoNormalized || p.legajo || '').slice(0, 60),
    cleanName: isCleanName(displayName(p)),
    hasDoors: hasDoorIds(p),
    allowedDoorIds: p.allowedDoorIds || null,
    dni: p.dniNormalized || p.idNumberNormalized || p.dni || null
  };
};

const commitInChunks = async (ops, label) => {
  let written = 0;
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const chunk = ops.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach((op) => {
      if (op.type === 'update') batch.update(op.ref, op.data);
      else if (op.type === 'delete') batch.delete(op.ref);
      else if (op.type === 'set') batch.set(op.ref, op.data, op.options || { merge: true });
    });
    await batch.commit();
    written += chunk.length;
    console.log(`  … ${label}: ${written}/${ops.length}`);
  }
};

const planMigration = (peopleSnap, authSnap) => {
  const authsByPersonId = new Map();
  const authDocsById = new Map();
  authSnap.docs.forEach((doc) => {
    authDocsById.set(doc.id, doc);
    const data = doc.data() || {};
    const personId = String(data.personId || '').trim();
    if (!personId) return;
    if (!authsByPersonId.has(personId)) authsByPersonId.set(personId, []);
    authsByPersonId.get(personId).push({
      id: doc.id,
      ref: doc.ref,
      type: data.type || null,
      startDate: data.startDate || data.appointmentDate || null,
      name: data.name || null,
      legajo: data.legajoNormalized || data.legajo || null
    });
  });

  const byLegajo = new Map();
  const ambiguousNoLegajo = [];

  peopleSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const entry = { id: doc.id, ref: doc.ref, data };
    const legajo = extractRealLegajo(data);
    if (!legajo) {
      ambiguousNoLegajo.push({
        reason: 'no se pudo extraer legajo confiable',
        ...summarizePerson(entry)
      });
      return;
    }
    if (!byLegajo.has(legajo)) byLegajo.set(legajo, []);
    byLegajo.get(legajo).push(entry);
  });

  const duplicateGroups = [];
  const singletonClean = [];
  const ambiguousConflicts = [];
  let docsToDelete = 0;
  let authsToRelink = 0;
  const sampleLoserAuths = [];
  const relinkOps = [];
  const deleteOps = [];
  const winnerPatchOps = [];

  for (const [legajo, docs] of byLegajo.entries()) {
    if (docs.length === 1) {
      singletonClean.push(legajo);
      continue;
    }

    const conflict = findAmbiguityInGroup(legajo, docs);
    if (conflict) {
      ambiguousConflicts.push({
        ...conflict,
        members: docs.map(summarizePerson)
      });
      continue;
    }

    const winner = pickWinner(docs);
    const losers = docs.filter((d) => d.id !== winner.id);
    const winnerName = displayName(winner.data);
    const loserAuthDetails = losers.map((loser) => {
      const auths = authsByPersonId.get(loser.id) || [];
      auths.forEach((auth) => {
        relinkOps.push({
          type: 'update',
          ref: auth.ref,
          data: {
            personId: winner.id,
            legajo: legajo,
            legajoNormalized: legajo,
            name: winnerName || auth.name || null,
            dedupedFromPersonId: loser.id,
            dedupedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          }
        });
      });
      return {
        personId: loser.id,
        person: summarizePerson(loser),
        authorizationCount: auths.length,
        authorizationIds: auths.map((a) => a.id),
        sampleAuths: auths.slice(0, 3)
      };
    });

    losers.forEach((loser) => {
      deleteOps.push({ type: 'delete', ref: loser.ref });
    });

    // Asegurar maestro limpio + puertas preservadas
    const winnerPatch = {
      legajo,
      legajoNormalized: legajo,
      dedupedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (isCleanName(winnerName)) {
      winnerPatch.nombre = winnerName;
      winnerPatch.name = winnerName;
    }
    if (!hasDoorIds(winner.data)) {
      const donor = losers.find((l) => hasDoorIds(l.data));
      if (donor) winnerPatch.allowedDoorIds = donor.data.allowedDoorIds;
    }
    winnerPatchOps.push({
      type: 'set',
      ref: winner.ref,
      data: winnerPatch,
      options: { merge: true }
    });

    const groupAuthsToRelink = loserAuthDetails.reduce((sum, row) => sum + row.authorizationCount, 0);
    docsToDelete += losers.length;
    authsToRelink += groupAuthsToRelink;

    if (sampleLoserAuths.length < 5 && groupAuthsToRelink > 0) {
      sampleLoserAuths.push({
        legajo,
        winnerId: winner.id,
        losers: loserAuthDetails
      });
    }

    duplicateGroups.push({
      legajo,
      size: docs.length,
      winner: summarizePerson(winner),
      losers: loserAuthDetails,
      authsToRelink: groupAuthsToRelink
    });
  }

  duplicateGroups.sort((a, b) => b.size - a.size);

  return {
    byLegajoSize: byLegajo.size,
    singletonClean,
    duplicateGroups,
    ambiguousNoLegajo,
    ambiguousConflicts,
    docsToDelete,
    authsToRelink,
    sampleLoserAuths,
    relinkOps,
    deleteOps,
    winnerPatchOps,
    peopleScanned: peopleSnap.size,
    authorizationsScanned: authSnap.size
  };
};

const main = async () => {
  console.log(write
    ? '=== APPLY dedupe people (ESCRITURA REAL) ===\n'
    : '=== DRY-RUN dedupe people (sin escrituras) ===\n');

  const [peopleSnap, authSnap] = await Promise.all([
    db.collection('people').get(),
    db.collection('authorizations').get()
  ]);

  console.log(`people: ${peopleSnap.size}`);
  console.log(`authorizations: ${authSnap.size}`);

  const plan = planMigration(peopleSnap, authSnap);
  const ambiguousCount = plan.ambiguousNoLegajo.length + plan.ambiguousConflicts.length;

  const report = {
    mode: write ? 'apply' : 'dry-run',
    totals: {
      peopleScanned: plan.peopleScanned,
      authorizationsScanned: plan.authorizationsScanned,
      uniqueRealLegajos: plan.byLegajoSize,
      singletonGroups: plan.singletonClean.length,
      duplicateGroups: plan.duplicateGroups.length,
      docsThatWouldBeDeleted: plan.docsToDelete,
      authorizationsThatWouldRelink: plan.authsToRelink,
      ambiguousManualReview: ambiguousCount,
      ambiguousNoLegajo: plan.ambiguousNoLegajo.length,
      ambiguousConflicts: plan.ambiguousConflicts.length
    },
    topDuplicateGroups: plan.duplicateGroups.slice(0, 15).map((g) => ({
      legajo: g.legajo,
      size: g.size,
      winnerId: g.winner.id,
      winnerName: g.winner.nombre,
      winnerClean: g.winner.cleanName,
      winnerHasDoors: g.winner.hasDoors,
      losersCount: g.losers.length,
      authsToRelink: g.authsToRelink,
      loserIds: g.losers.map((l) => l.personId)
    })),
    sampleLoserAuthorizations: plan.sampleLoserAuths,
    ambiguousNoLegajoSample: plan.ambiguousNoLegajo.slice(0, 20),
    ambiguousConflictsSample: plan.ambiguousConflicts.slice(0, 20),
    allAmbiguousConflicts: plan.ambiguousConflicts.map((c) => ({
      legajo: c.legajo,
      reason: c.reason,
      names: c.names || null,
      dnis: c.dnis || null,
      docIds: c.docIds,
      members: c.members
    })),
    allAmbiguousNoLegajo: plan.ambiguousNoLegajo
  };

  const outPath = path.join(
    __dirname,
    write ? 'migrate-dedupe-dirty-people.apply.json' : 'migrate-dedupe-dirty-people.dry-run.json'
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n=== RESUMEN PLAN ===');
  console.log(JSON.stringify(report.totals, null, 2));
  console.log('\nTop grupos duplicados (hasta 10):');
  report.topDuplicateGroups.slice(0, 10).forEach((g) => {
    console.log(
      `  legajo ${g.legajo}: ${g.size} docs → conservar ${g.winnerId} (${g.winnerName.slice(0, 40)})`
      + ` | borrar ${g.losersCount} | re-vincular ${g.authsToRelink} auths`
    );
  });

  console.log(`\nCasos ambiguos (revisar a mano): ${report.totals.ambiguousManualReview}`);
  console.log(`Reporte: ${outPath}`);

  if (ambiguousCount > 0) {
    console.error('\nABORT: hay casos ambiguos. No se escribe nada hasta revisión manual.');
    process.exit(1);
  }

  if (!write) {
    console.log('\nDry-run OK. Para aplicar: node migrate-dedupe-dirty-people.js --apply');
    return;
  }

  console.log('\n--- Aplicando re-vinculación de authorizations ---');
  await commitInChunks(plan.relinkOps, 'relink auths');

  console.log('\n--- Parcheando docs ganadores ---');
  await commitInChunks(plan.winnerPatchOps, 'patch winners');

  console.log('\n--- Eliminando docs perdedores ---');
  await commitInChunks(plan.deleteOps, 'delete people');

  const [peopleAfter, authAfter] = await Promise.all([
    db.collection('people').get(),
    db.collection('authorizations').get()
  ]);

  const peopleIds = new Set(peopleAfter.docs.map((d) => d.id));
  let orphanAuths = 0;
  let missingPersonId = 0;
  authAfter.docs.forEach((doc) => {
    const personId = String(doc.data()?.personId || '').trim();
    if (!personId) {
      missingPersonId += 1;
      return;
    }
    if (!peopleIds.has(personId)) orphanAuths += 1;
  });

  console.log('\n=== POST-APPLY ===');
  console.log(JSON.stringify({
    peopleAfter: peopleAfter.size,
    authorizationsAfter: authAfter.size,
    expectedPeople: plan.byLegajoSize,
    deletedPeople: plan.docsToDelete,
    relinkedAuths: plan.authsToRelink,
    orphanAuths,
    missingPersonId
  }, null, 2));

  if (peopleAfter.size !== plan.byLegajoSize) {
    console.error(`ALERTA: people=${peopleAfter.size}, esperado=${plan.byLegajoSize}`);
    process.exit(1);
  }
  if (orphanAuths > 0) {
    console.error(`ALERTA: ${orphanAuths} authorizations huérfanas`);
    process.exit(1);
  }

  console.log('\nApply completado OK.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
