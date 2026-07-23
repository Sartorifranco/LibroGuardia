/**
 * Diagnóstico: personas que hoy la nómina autorizaría pero decidirAcceso no.
 * Uso: node scripts/diagnoseNominaOnlyAccess.js
 */
const fs = require('fs');
const path = require('path');
const { getArgentinaDateParts } = require('../lib/normalize');
const { isSistemasArea, isCitacionRequiredArea } = require('../lib/centroCostoGroups');
const { evaluateExpectedToday } = require('../attendanceAlerts');

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
  if ('arrayValue' in field) return (field.arrayValue.values || []).map(fieldValue);
  if ('mapValue' in field) {
    const out = {};
    const f = field.mapValue.fields || {};
    Object.keys(f).forEach((k) => {
      out[k] = fieldValue(f[k]);
    });
    return out;
  }
  return undefined;
};

const docData = (doc) => {
  const out = { id: (doc.name || '').split('/').pop() };
  const fields = doc.fields || {};
  Object.keys(fields).forEach((key) => {
    out[key] = fieldValue(fields[key]);
  });
  return out;
};

async function firestoreFetch(pathname) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function listAll(collectionId) {
  const docs = [];
  let pageToken;
  do {
    const qs = new URLSearchParams({ pageSize: '300' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await firestoreFetch(`/documents/${collectionId}?${qs}`);
    docs.push(...(data.documents || []).map(docData));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

const normalizeDni = (value) => String(value || '').replace(/\D/g, '');

const hasDoorList = (person) =>
  Array.isArray(person?.allowedDoorIds) && person.allowedDoorIds.length > 0;

const decidirWouldAuthorize = (authByPerson, personId, today) => {
  const auths = authByPerson.get(personId) || [];
  for (const a of auths) {
    if (a.type === 'permanent') return { ok: true, via: 'permanent' };
    if (a.type === 'citacion' && (a.appointmentDate || a.startDate) === today) {
      return { ok: true, via: 'citacion' };
    }
    if (['visita', 'visit', 'temporal'].includes(a.type)) {
      const start = a.startDate;
      const end = a.endDate || a.startDate;
      if (start && today >= start && today <= end) return { ok: true, via: a.type };
    }
  }
  return { ok: false };
};

async function main() {
  const { dateString: today, dayCode } = getArgentinaDateParts(new Date());
  console.log('Diagnóstico nómina-only', { today, dayCode });

  const [people, personal, authorizations] = await Promise.all([
    listAll('people'),
    listAll('personalMaster'),
    listAll('authorizations')
  ]);

  const nomina = personal.filter((p) => p.source === 'nomina' && p.active !== false);
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const peopleByDni = new Map();
  for (const p of people) {
    const dni = normalizeDni(p.dniNormalized || p.dni || p.idNumberNormalized || '');
    if (dni) peopleByDni.set(dni, p);
  }

  const activeAuths = authorizations.filter((a) => a.active === true);
  const authByPerson = new Map();
  for (const a of activeAuths) {
    if (!a.personId) continue;
    if (!authByPerson.has(a.personId)) authByPerson.set(a.personId, []);
    authByPerson.get(a.personId).push(a);
  }

  const citacionesToday = activeAuths.filter((a) => {
    if (a.type !== 'citacion') return false;
    return (a.appointmentDate || a.startDate) === today;
  });

  let nominaAuthTrue = 0;
  let onlyNomina = 0;
  let onlyNominaWithDoors = 0;
  let onlyNominaWithoutDoors = 0;
  let onlyNominaNoPeople = 0;
  const byReason = {};
  const samples = { withDoors: [], withoutDoors: [], noPeople: [] };

  for (const emp of nomina) {
    const centro = emp.centroCosto || emp.company || '';
    let nominaOk = false;
    let reason = null;

    if (isSistemasArea(centro)) {
      nominaOk = true;
      reason = 'sistemas_acceso_permanente';
    } else {
      const evaluation = evaluateExpectedToday(emp, { dayCode, citacionesToday });
      if (evaluation.expected) {
        nominaOk = true;
        reason = isCitacionRequiredArea(centro)
          ? 'citacion_hoy'
          : (evaluation.reason || 'turno_hoy');
      }
    }
    if (!nominaOk) continue;

    nominaAuthTrue += 1;
    byReason[reason] = (byReason[reason] || 0) + 1;

    const dni = normalizeDni(emp.idNumberNormalized || emp.idNumber || '');
    const person = (emp.personId && peopleById.get(emp.personId))
      || (dni && peopleByDni.get(dni))
      || null;
    const personId = person?.id || emp.personId || null;
    const dec = personId
      ? decidirWouldAuthorize(authByPerson, personId, today)
      : { ok: false };

    if (dec.ok) continue;

    onlyNomina += 1;
    const row = {
      name: emp.name || person?.nombre || person?.name || '',
      dni,
      centro,
      reason,
      personId: person?.id || null,
      doors: person?.allowedDoorIds || []
    };

    if (!person) {
      onlyNominaNoPeople += 1;
      if (samples.noPeople.length < 8) samples.noPeople.push(row);
    } else if (hasDoorList(person)) {
      onlyNominaWithDoors += 1;
      if (samples.withDoors.length < 12) samples.withDoors.push(row);
    } else {
      onlyNominaWithoutDoors += 1;
      if (samples.withoutDoors.length < 8) samples.withoutDoors.push(row);
    }
  }

  console.log(JSON.stringify({
    counts: {
      people: people.length,
      personalMasterNominaActive: nomina.length,
      nominaWouldAuthorizeToday: nominaAuthTrue,
      onlyNominaNotDecidir: onlyNomina,
      onlyNominaWithDoors_canEnterOnline: onlyNominaWithDoors,
      onlyNominaWithoutDoors_blockedByDoorCheck: onlyNominaWithoutDoors,
      onlyNominaNoPeopleDoc: onlyNominaNoPeople,
      citacionesToday: citacionesToday.length
    },
    byReason,
    samples
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
