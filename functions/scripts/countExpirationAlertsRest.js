/**
 * Conteo via Firestore REST + token del Firebase CLI (misma lógica del banner).
 * Uso: node scripts/countExpirationAlertsRest.js
 */
const fs = require('fs');
const path = require('path');
const {
  evaluateExpiry,
  shouldAlertAuthorizationExpiry
} = require('../lib/documentExpiry');
const { getArgentinaDateString } = require('../lib/normalize');

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
  if ('doubleValue' in field) return field.doubleValue;
  if ('booleanValue' in field) return field.booleanValue;
  if ('timestampValue' in field) return field.timestampValue;
  if ('nullValue' in field) return null;
  return undefined;
};

const docData = (doc) => {
  const out = {};
  const fields = doc.fields || {};
  Object.keys(fields).forEach((key) => {
    out[key] = fieldValue(fields[key]);
  });
  return out;
};

async function firestoreFetch(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

async function listAllDocuments(collectionId) {
  const docs = [];
  let pageToken;
  do {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await firestoreFetch(`/documents/${collectionId}?${qs}`);
    docs.push(...(data.documents || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs.map(docData);
}

async function listActiveAuthorizations() {
  const all = await listAllDocuments('authorizations');
  return all.filter((row) => row.active === true);
}

async function main() {
  const today = getArgentinaDateString();
  const empty = () => ({ expired: 0, endingIn7: 0, endingIn15: 0, endingIn30: 0 });
  const byKind = {
    authorization: empty(),
    art: empty(),
    license: empty(),
    insurance: empty(),
    vtv: empty()
  };
  const bump = (kind, bucket) => {
    if (byKind[kind][bucket] !== undefined) byKind[kind][bucket] += 1;
  };

  const [auths, personal, vehicles] = await Promise.all([
    listActiveAuthorizations(),
    listAllDocuments('personalMaster'),
    listAllDocuments('vehiclesMaster')
  ]);

  const authByType = {};
  let citacionesSkipped = 0;
  let citacionesThatLookExpiredButExcluded = 0;

  auths.forEach((data) => {
    const t = String(data.type || '(empty)');
    authByType[t] = (authByType[t] || 0) + 1;
    if (String(data.type || '').toLowerCase() === 'citacion') {
      citacionesSkipped += 1;
      const ev = evaluateExpiry(
        data.endDate || data.startDate || data.appointmentDate,
        today
      );
      if (ev?.bucket === 'expired') citacionesThatLookExpiredButExcluded += 1;
      return;
    }
    if (!shouldAlertAuthorizationExpiry(data)) return;
    const ev = evaluateExpiry(data.endDate, today);
    if (ev) bump('authorization', ev.bucket);
  });

  personal.forEach((data) => {
    [
      ['artExpiryDate', 'art'],
      ['licenseExpiryDate', 'license']
    ].forEach(([key, kind]) => {
      const ev = evaluateExpiry(data[key], today);
      if (ev) bump(kind, ev.bucket);
    });
  });

  vehicles.forEach((data) => {
    [
      ['insuranceExpiryDate', 'insurance'],
      ['vtvExpiryDate', 'vtv']
    ].forEach(([key, kind]) => {
      const ev = evaluateExpiry(data[key], today);
      if (ev) bump(kind, ev.bucket);
    });
  });

  const sum = (bucket) => Object.values(byKind).reduce((acc, row) => acc + row[bucket], 0);

  const summary = {
    today,
    authorizationsActiveTotal: auths.length,
    authorizationsByType: authByType,
    citacionesExcludedFromBanner: citacionesSkipped,
    citacionesThatLookExpiredButExcluded,
    realAlerts: {
      expired: sum('expired'),
      endingIn7: sum('endingIn7'),
      endingIn15: sum('endingIn15'),
      endingIn30: sum('endingIn30'),
      totalInBannerWindows:
        sum('expired') + sum('endingIn7') + sum('endingIn15') + sum('endingIn30')
    },
    byKind,
    masters: {
      personalMaster: personal.length,
      vehiclesMaster: vehicles.length
    },
    note: 'Conteos sin tope de 40 del endpoint; el banner sigue truncando por bucket en API/UI.'
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
