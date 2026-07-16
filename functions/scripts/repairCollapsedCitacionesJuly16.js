/**
 * Repara citaciones colapsadas del 2026-07-16 (fecha mal interpretada como DNI).
 * Fuente: snapshot citacionesImports (45 filas correctas).
 *
 * Uso:
 *   node scripts/repairCollapsedCitacionesJuly16.js
 *   node scripts/repairCollapsedCitacionesJuly16.js --apply
 */
const fs = require('fs');
const path = require('path');
const { buildNameTokens, normalizePersonName } = require('../lib/nameUtils');
const { normalizeLegajo } = require('../lib/personMatch');

const PROJECT = 'legajosonline-959f6';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const APPLY = process.argv.includes('--apply');
const TARGET_DATE = '2026-07-16';
const LEGACY_IMPORT_ID = 'G2x5gGaYTnyHOJA547FA';
const BAD_BATCH_ID = '7lwLRMJFx77MbgihLhFt';
const COLLAPSED_AUTH_ID = 'u4D5Wrz0n2ci7cdN9CBO';

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
  if ('arrayValue' in field) {
    return (field.arrayValue.values || []).map((item) => {
      if (item.mapValue) {
        const out = {};
        Object.entries(item.mapValue.fields || {}).forEach(([k, v]) => {
          out[k] = fieldValue(v);
        });
        return out;
      }
      return fieldValue(item);
    });
  }
  if ('mapValue' in field) {
    const out = {};
    Object.entries(field.mapValue.fields || {}).forEach(([k, v]) => {
      out[k] = fieldValue(v);
    });
    return out;
  }
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

async function listSubcollection(parentPath, collectionId) {
  const docs = [];
  let pageToken;
  do {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await firestore(`/documents/${parentPath}/${collectionId}?${qs}`);
    docs.push(...(data.documents || []).map(docData));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

const extractAppointmentTime = (notes = '') => {
  const match = String(notes).match(/(\d{1,2}:\d{2})/);
  return match ? match[1].padStart(5, '0') : null;
};

const buildAuthFields = (row, { personId = null, idNumber = '' } = {}) => {
  const legajoNormalized = normalizeLegajo(row.legajo) || String(row.legajo || '').trim();
  const name = String(row.name || '').trim();
  const nameKey = buildNameTokens(name);
  const appointmentTime = extractAppointmentTime(row.notes);
  const idNumberNormalized = String(idNumber || '').replace(/\D/g, '');
  // Nunca guardar la fecha como DNI.
  const safeId = idNumberNormalized === TARGET_DATE.replace(/\D/g, '') ? '' : idNumberNormalized;

  return {
    type: 'citacion',
    name,
    nameLower: normalizePersonName(name),
    nameKey,
    nameTokens: nameKey,
    personId: personId || null,
    idNumber: safeId,
    idNumberNormalized: safeId,
    legajo: legajoNormalized,
    legajoNormalized,
    company: String(row.company || row.destination || '').trim(),
    destination: String(row.destination || '').trim(),
    role: String(row.role || '').trim(),
    startDate: TARGET_DATE,
    endDate: TARGET_DATE,
    appointmentDate: TARGET_DATE,
    appointmentTime,
    daysOfWeek: null,
    timeWindow: null,
    notes: String(row.notes || '').trim(),
    source: 'import',
    importBatchId: BAD_BATCH_ID,
    importSource: 'Citaciones_2026_07_16.xlsx',
    active: true,
    repairedAt: new Date().toISOString(),
    repairedBy: 'repairCollapsedCitacionesJuly16',
    updatedBy: 'repairCollapsedCitacionesJuly16'
  };
};

async function main() {
  console.log(APPLY ? 'MODO APPLY' : 'DRY-RUN (pasar --apply para escribir)');

  const legacy = docData(await firestore(`/documents/citacionesImports/${LEGACY_IMPORT_ID}`));
  const rows = Array.isArray(legacy.rows) ? legacy.rows : [];
  console.log(`Snapshot ${LEGACY_IMPORT_ID}: ${rows.length} filas`);

  const importRows = await listSubcollection(`importBatches/${BAD_BATCH_ID}`, 'importRows');
  const personByLegajo = new Map();
  importRows.forEach((row) => {
    const legajo = normalizeLegajo(row.legajo) || String(row.legajo || '').trim();
    if (legajo && row.resolvedPersonId) personByLegajo.set(legajo, row.resolvedPersonId);
  });

  const allAuth = [];
  let pageToken;
  do {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await firestore(`/documents/authorizations?${qs}`);
    allAuth.push(...(data.documents || []).map(docData));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const activeToday = allAuth.filter(
    (doc) => doc.type === 'citacion'
      && doc.active === true
      && (doc.startDate === TARGET_DATE || doc.appointmentDate === TARGET_DATE)
  );
  console.log(`Citaciones activas hoy (antes): ${activeToday.length}`);

  const byLegajo = new Map();
  activeToday.forEach((doc) => {
    const key = normalizeLegajo(doc.legajoNormalized || doc.legajo) || doc.id;
    byLegajo.set(key, doc);
  });

  // También indexar inactivas del día por si hay que reactivar.
  allAuth
    .filter((doc) => doc.type === 'citacion'
      && (doc.startDate === TARGET_DATE || doc.appointmentDate === TARGET_DATE))
    .forEach((doc) => {
      const key = normalizeLegajo(doc.legajoNormalized || doc.legajo);
      if (key && !byLegajo.has(key)) byLegajo.set(key, doc);
    });

  const plan = [];
  const seen = new Set();
  for (const row of rows) {
    const legajo = normalizeLegajo(row.legajo) || String(row.legajo || '').trim();
    if (!legajo || seen.has(legajo)) continue;
    seen.add(legajo);

    const existing = byLegajo.get(legajo) || null;
    const personId = personByLegajo.get(legajo) || existing?.personId || null;
    const fields = buildAuthFields(row, { personId });

    plan.push({
      action: existing ? 'update' : 'create',
      authId: existing?.id || null,
      legajo,
      name: fields.name,
      role: fields.role
    });
  }

  console.log(`Plan: ${plan.filter((p) => p.action === 'create').length} create, ${plan.filter((p) => p.action === 'update').length} update`);
  console.log('Muestra:', plan.slice(0, 5));

  if (!APPLY) {
    console.log('Dry-run OK. Ejecutar con --apply para reparar.');
    return;
  }

  let created = 0;
  let updated = 0;

  for (const item of plan) {
    const row = rows.find((r) => (normalizeLegajo(r.legajo) || String(r.legajo || '').trim()) === item.legajo);
    const personId = personByLegajo.get(item.legajo) || null;
    const fields = buildAuthFields(row, { personId });
    const firestoreFields = {};
    Object.entries(fields).forEach(([key, value]) => {
      firestoreFields[key] = toFirestoreValue(value);
    });
    firestoreFields.updatedAt = { timestampValue: new Date().toISOString() };

    if (item.action === 'update' && item.authId) {
      // Patch sin tocar createdAt
      const mask = Object.keys(fields).concat(['updatedAt']).join(',');
      await firestore(`/documents/authorizations/${item.authId}?updateMask.fieldPaths=${mask.split(',').map((f) => encodeURIComponent(f)).join('&updateMask.fieldPaths=')}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: firestoreFields })
      });
      updated += 1;
    } else {
      firestoreFields.createdAt = { timestampValue: new Date().toISOString() };
      firestoreFields.createdBy = toFirestoreValue('repairCollapsedCitacionesJuly16');
      await firestore('/documents/authorizations', {
        method: 'POST',
        body: JSON.stringify({ fields: firestoreFields })
      });
      created += 1;
    }
  }

  // Asegurar que el doc colapsado no quede con DNI=fecha si no fue tocado por legajo distinto.
  try {
    const collapsed = docData(await firestore(`/documents/authorizations/${COLLAPSED_AUTH_ID}`));
    if (collapsed.idNumberNormalized === '20260716' || collapsed.idNumber === '20260716') {
      await firestore(`/documents/authorizations/${COLLAPSED_AUTH_ID}?updateMask.fieldPaths=idNumber&updateMask.fieldPaths=idNumberNormalized`, {
        method: 'PATCH',
        body: JSON.stringify({
          fields: {
            idNumber: toFirestoreValue(''),
            idNumberNormalized: toFirestoreValue('')
          }
        })
      });
      console.log(`Limpiado DNI basura en ${COLLAPSED_AUTH_ID}`);
    }
  } catch (err) {
    console.warn('No se pudo limpiar doc colapsado:', err.message);
  }

  console.log(`Listo: created=${created}, updated=${updated}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
