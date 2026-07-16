/**
 * Fase 17.3 — backfill masivo de citaciones con CSV crudo.
 * - Dry-run por defecto; aplicar con --apply
 * - Guarda backup en cada doc (rawImportBackup) + colección authorizations_backfill_backup
 *
 * Uso:
 *   node scripts/citacionesBackfillApply.js
 *   node scripts/citacionesBackfillApply.js --apply
 */
const fs = require('fs');
const path = require('path');
const {
  looksLikeBrokenTransportCitacion,
  canConfidentlyRepairCitacion,
  applyTransportParseToCitacion
} = require('../lib/transportCsvParser');

const PROJECT = 'legajosonline-959f6';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = 40;

const cfg = JSON.parse(
  fs.readFileSync(path.join(process.env.USERPROFILE, '.config/configstore/firebase-tools.json'), 'utf8')
);
const token = cfg.tokens.access_token;

const fieldValue = (field) => {
  if (!field || typeof field !== 'object') return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('integerValue' in field) return Number(field.integerValue);
  if ('doubleValue' in field) return field.doubleValue;
  if ('booleanValue' in field) return field.booleanValue;
  if ('nullValue' in field) return null;
  if ('timestampValue' in field) return field.timestampValue;
  return undefined;
};

const toFirestoreValue = (value) => {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    const fields = {};
    Object.entries(value).forEach(([key, nested]) => {
      if (nested !== undefined) fields[key] = toFirestoreValue(nested);
    });
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
};

const docData = (doc) => {
  const out = { id: doc.name.split('/').pop(), _name: doc.name };
  Object.entries(doc.fields || {}).forEach(([key, value]) => {
    out[key] = fieldValue(value);
  });
  return out;
};

async function firestore(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${res.status} ${pathname} ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

async function listAllDocuments(collectionId) {
  const docs = [];
  let pageToken;
  do {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await firestore(`/documents/${collectionId}?${qs}`);
    docs.push(...(data.documents || []).map(docData));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

const buildPatch = (doc, repaired) => {
  const backup = {
    backedUpAt: new Date().toISOString(),
    name: doc.name || null,
    legajo: doc.legajo || null,
    legajoNormalized: doc.legajoNormalized || null,
    nameKey: doc.nameKey || null,
    nameTokens: doc.nameTokens || null,
    role: doc.role || null,
    destination: doc.destination || null,
    company: doc.company || null,
    startDate: doc.startDate || null,
    endDate: doc.endDate || null,
    appointmentDate: doc.appointmentDate || null,
    appointmentTime: doc.appointmentTime || null,
    notes: doc.notes || null
  };

  return {
    backup,
    fields: {
      rawImportBackup: toFirestoreValue(backup),
      name: toFirestoreValue(repaired.name),
      nameKey: toFirestoreValue(repaired.nameKey || ''),
      nameTokens: toFirestoreValue(repaired.nameTokens || repaired.nameKey || ''),
      legajo: toFirestoreValue(repaired.legajo),
      legajoNormalized: toFirestoreValue(repaired.legajoNormalized || repaired.legajo),
      role: toFirestoreValue(repaired.role || ''),
      destination: toFirestoreValue(repaired.destination || ''),
      company: toFirestoreValue(repaired.company || ''),
      startDate: toFirestoreValue(repaired.startDate || doc.startDate || ''),
      endDate: toFirestoreValue(repaired.endDate || repaired.startDate || doc.endDate || doc.startDate || ''),
      appointmentDate: toFirestoreValue(repaired.appointmentDate || repaired.startDate || doc.appointmentDate || ''),
      appointmentTime: repaired.appointmentTime
        ? toFirestoreValue(repaired.appointmentTime)
        : { nullValue: null },
      relinkedAt: { timestampValue: new Date().toISOString() },
      backfillPhase: toFirestoreValue('17.3'),
      updatedAt: { timestampValue: new Date().toISOString() }
    },
    backupDoc: {
      fields: {
        authorizationId: toFirestoreValue(doc.id),
        backedUpAt: { timestampValue: new Date().toISOString() },
        phase: toFirestoreValue('17.3'),
        before: toFirestoreValue(backup),
        after: toFirestoreValue({
          name: repaired.name,
          legajo: repaired.legajo,
          legajoNormalized: repaired.legajoNormalized,
          role: repaired.role || '',
          destination: repaired.destination || '',
          startDate: repaired.startDate || '',
          appointmentTime: repaired.appointmentTime || null
        })
      }
    }
  };
};

async function commitBatch(writes) {
  // POST .../databases/(default)/documents:commit
  return firestore('/documents:commit', {
    method: 'POST',
    body: JSON.stringify({ writes })
  });
}

async function main() {
  const all = await listAllDocuments('authorizations');
  const candidates = all.filter((d) => d.active === true
    && d.type === 'citacion'
    && looksLikeBrokenTransportCitacion(d));

  const repairable = [];
  const manual = [];

  candidates.forEach((doc) => {
    if (canConfidentlyRepairCitacion(doc)) repairable.push(doc);
    else manual.push(doc);
  });

  console.log(JSON.stringify({
    mode: APPLY ? 'APPLY' : 'dry-run',
    candidates: candidates.length,
    repairable: repairable.length,
    manualReview: manual.length,
    backupStrategy: {
      perDocumentField: 'rawImportBackup (en cada authorization corregida)',
      collection: 'authorizations_backfill_backup/{authorizationId}',
      coversAllRepairable: true,
      notOnlySample: true
    }
  }, null, 2));

  if (!APPLY) {
    console.log('\nSin --apply: no se escribió nada. Reejecutar con --apply para aplicar.');
    return;
  }

  let corrected = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < repairable.length; i += BATCH_SIZE) {
    const slice = repairable.slice(i, i + BATCH_SIZE);
    const writes = [];

    slice.forEach((doc) => {
      const repaired = applyTransportParseToCitacion(doc);
      const patch = buildPatch(doc, repaired);
      const docPath = `projects/${PROJECT}/databases/(default)/documents/authorizations/${doc.id}`;
      const backupPath = `projects/${PROJECT}/databases/(default)/documents/authorizations_backfill_backup/${doc.id}`;

      writes.push({
        update: {
          name: docPath,
          fields: patch.fields
        },
        updateMask: {
          fieldPaths: Object.keys(patch.fields)
        }
      });
      writes.push({
        update: {
          name: backupPath,
          fields: patch.backupDoc.fields
        }
      });
    });

    try {
      await commitBatch(writes);
      corrected += slice.length;
      console.log(`OK batch ${i / BATCH_SIZE + 1}: +${slice.length} (total ${corrected}/${repairable.length})`);
    } catch (err) {
      failed += slice.length;
      failures.push({ from: i, error: err.message });
      console.error(`FAIL batch starting ${i}:`, err.message);
    }
  }

  const summary = {
    mode: 'APPLY',
    corrected,
    failed,
    manualReview: manual.length,
    manualSample: manual.slice(0, 20).map((d) => ({
      id: d.id,
      name: String(d.name || '').slice(0, 80),
      startDate: d.startDate || null
    })),
    failures
  };
  console.log(JSON.stringify(summary, null, 2));

  const outPath = path.join(__dirname, `citaciones-backfill-summary-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log('Summary written:', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
