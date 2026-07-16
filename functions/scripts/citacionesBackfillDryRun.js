/**
 * Fase 17.2 — dry-run de backfill de citaciones con CSV crudo en name/legajo.
 * No escribe en Firestore.
 *
 * Uso: node scripts/citacionesBackfillDryRun.js
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

const cfg = JSON.parse(
  fs.readFileSync(path.join(process.env.USERPROFILE, '.config/configstore/firebase-tools.json'), 'utf8')
);
const token = cfg.tokens.access_token;

const fieldValue = (field) => {
  if (!field || typeof field !== 'object') return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('integerValue' in field) return Number(field.integerValue);
  if ('booleanValue' in field) return field.booleanValue;
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

async function listAllDocuments(collectionId) {
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

const shortCsv = (value = '') => {
  const s = String(value || '');
  if (s.length <= 72) return s;
  return `${s.slice(0, 69)}...`;
};

const pickSample = (broken) => {
  const brizuela = broken.find((doc) => /Brizuela Hector Daniel/i.test(`${doc.name}|${doc.legajo}`));
  const guzman = broken.find((doc) => /Guzman Michael Carlos Gabriel/i.test(`${doc.name}|${doc.legajo}`));
  const anchors = [brizuela, guzman].filter(Boolean);

  // Un doc por nombre parseado distinto (máx. variedad)
  const byParsedName = new Map();
  broken.forEach((doc) => {
    if (!canConfidentlyRepairCitacion(doc)) return;
    const after = applyTransportParseToCitacion(doc);
    const key = `${after.legajoNormalized}|${after.name}`;
    if (!byParsedName.has(key)) byParsedName.set(key, doc);
  });

  const diverse = [...byParsedName.values()]
    .filter((doc) => !anchors.some((a) => a.id === doc.id))
    .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));

  const spaced = [];
  const step = Math.max(1, Math.floor(diverse.length / 18));
  for (let i = 0; i < diverse.length && spaced.length < 18; i += step) {
    spaced.push(diverse[i]);
  }

  const chosen = [];
  const seen = new Set();
  [...anchors, ...spaced].forEach((doc) => {
    if (!doc || seen.has(doc.id)) return;
    seen.add(doc.id);
    chosen.push(doc);
  });
  return chosen.slice(0, 20);
};

async function main() {
  const all = await listAllDocuments('authorizations');
  const activeCit = all.filter((d) => d.active === true && d.type === 'citacion');
  const broken = activeCit.filter((d) => looksLikeBrokenTransportCitacion(d));
  const globalConfident = broken.filter((d) => canConfidentlyRepairCitacion(d)).length;
  const globalUncertain = broken.length - globalConfident;
  const sample = pickSample(broken);

  const rows = sample.map((doc) => {
    const confident = canConfidentlyRepairCitacion(doc);
    const after = confident ? applyTransportParseToCitacion(doc) : null;
    return {
      id: doc.id,
      confident,
      before: {
        legajo: shortCsv(doc.legajo),
        nombre: shortCsv(doc.name),
        puesto: doc.role || '',
        fecha: doc.startDate || doc.appointmentDate || ''
      },
      after: after
        ? {
          legajo: after.legajoNormalized || after.legajo,
          nombre: after.name,
          puesto: after.role || '',
          fecha: after.startDate || after.appointmentDate || '',
          hora: after.appointmentTime || ''
        }
        : null
    };
  });

  const uncertain = rows.filter((r) => !r.confident);

  console.log(JSON.stringify({
    mode: 'dry-run',
    activeCitaciones: activeCit.length,
    brokenCandidates: broken.length,
    globalConfidentRepairable: globalConfident,
    globalUncertain: globalUncertain,
    sampleSize: rows.length,
    confidentInSample: rows.filter((r) => r.confident).length,
    uncertainInSample: uncertain.length,
    rows,
    uncertainIds: uncertain.map((r) => r.id)
  }, null, 2));

  // Tabla markdown simples para copiar
  console.log('\n--- TABLA ANTES → DESPUÉS ---\n');
  console.log('| # | Confianza | Legajo antes → después | Nombre después | Puesto | Fecha |');
  console.log('|---|-----------|------------------------|----------------|--------|-------|');
  rows.forEach((r, idx) => {
    const legajoAfter = r.after?.legajo || '—';
    const nombreAfter = r.after?.nombre || '(sin reconstrucción)';
    const puesto = r.after?.puesto || '—';
    const fecha = r.after?.fecha || r.before.fecha || '—';
    console.log(
      `| ${idx + 1} | ${r.confident ? 'OK' : 'REVISAR'} | ${shortCsv(r.before.legajo).replace(/\|/g, '/')} → ${legajoAfter} | ${nombreAfter} | ${puesto} | ${fecha} |`
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
