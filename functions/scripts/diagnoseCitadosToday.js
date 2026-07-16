/**
 * Diagnóstico: citaciones activas por fecha vs lo que ve Citados.
 * Uso: node scripts/diagnoseCitadosToday.js
 */
const fs = require('fs');
const path = require('path');
const { getArgentinaDateString } = require('../lib/normalize');
const { hydrateAuthorizationForRead } = require('../lib/transportCsvParser');

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
  if ('integerValue' in field) return Number(field.integerValue);
  if ('nullValue' in field) return null;
  if ('timestampValue' in field) return field.timestampValue;
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
    if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 400));
    docs.push(...(data.documents || []).map(docData));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

async function main() {
  const today = getArgentinaDateString();
  const all = await listAll('authorizations');
  const citaciones = all.filter((d) => d.type === 'citacion');
  const active = citaciones.filter((d) => d.active === true);

  const byDateActive = {};
  const byDateInactive = {};
  const todayRows = [];

  active.forEach((raw) => {
    const d = hydrateAuthorizationForRead(raw);
    const date = d.appointmentDate || d.startDate || '(sin fecha)';
    byDateActive[date] = (byDateActive[date] || 0) + 1;
    if (date === today) {
      todayRows.push({
        id: d.id,
        name: d.name,
        legajo: d.legajoNormalized || d.legajo,
        role: d.role || '',
        destination: d.destination || '',
        source: d.source || '',
        importBatchId: d.importBatchId || null,
        startDate: d.startDate,
        appointmentDate: d.appointmentDate
      });
    }
  });

  citaciones.filter((d) => d.active !== true).forEach((raw) => {
    const d = hydrateAuthorizationForRead(raw);
    const date = d.appointmentDate || d.startDate || '(sin fecha)';
    byDateInactive[date] = (byDateInactive[date] || 0) + 1;
  });

  const sortedActive = Object.entries(byDateActive).sort((a, b) => b[0].localeCompare(a[0]));
  const recent = sortedActive.slice(0, 10);

  // Samples of inactive for today (if any)
  const todayInactive = citaciones
    .filter((d) => d.active !== true)
    .map((raw) => hydrateAuthorizationForRead(raw))
    .filter((d) => (d.appointmentDate || d.startDate) === today)
    .slice(0, 5)
    .map((d) => ({
      name: d.name,
      legajo: d.legajoNormalized || d.legajo,
      revokedBy: d.revokedBy || null,
      active: d.active
    }));

  console.log(JSON.stringify({
    todayArgentina: today,
    totalCitaciones: citaciones.length,
    activeCitaciones: active.length,
    activeForToday: todayRows.length,
    inactiveForToday: byDateInactive[today] || 0,
    recentActiveByDate: recent,
    todaySample: todayRows.slice(0, 15),
    todayInactiveSample: todayInactive
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
