/**
 * Cuenta entries con el mismo patrón de CSV crudo en name/legajo.
 */
const fs = require('fs');
const path = require('path');
const { looksLikeBrokenTransportCitacion } = require('../lib/transportCsvParser');

const PROJECT = 'legajosonline-959f6';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const cfg = JSON.parse(
  fs.readFileSync(path.join(process.env.USERPROFILE, '.config/configstore/firebase-tools.json'), 'utf8')
);
const token = cfg.tokens.access_token;

const fieldValue = (field) => {
  if (!field || typeof field !== 'object') return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('booleanValue' in field) return field.booleanValue;
  if ('nullValue' in field) return null;
  return undefined;
};

const docData = (doc) => {
  const out = { id: doc.name.split('/').pop() };
  Object.entries(doc.fields || {}).forEach(([key, value]) => {
    out[key] = fieldValue(value);
  });
  return out;
};

async function listAll(collectionId) {
  const docs = [];
  let pageToken;
  do {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    const res = await fetch(`${BASE}/documents/${collectionId}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 300));
    docs.push(...(data.documents || []).map(docData));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

const looksBrokenEntry = (entry) => {
  const stub = {
    name: entry.name || entry.nameSnapshot || '',
    legajo: entry.legajo || entry.legajoNormalized || '',
    notes: entry.notes || ''
  };
  return looksLikeBrokenTransportCitacion(stub);
};

async function main() {
  const entries = await listAll('entries');
  const broken = entries.filter(looksBrokenEntry);
  const byType = {};
  broken.forEach((e) => {
    const t = e.type || '(none)';
    byType[t] = (byType[t] || 0) + 1;
  });
  console.log(JSON.stringify({
    entriesTotal: entries.length,
    entriesBrokenLooking: broken.length,
    byType,
    samples: broken.slice(0, 8).map((e) => ({
      id: e.id,
      type: e.type || null,
      movementType: e.movementType || null,
      name: String(e.name || e.nameSnapshot || '').slice(0, 120),
      legajo: String(e.legajo || '').slice(0, 80)
    }))
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
