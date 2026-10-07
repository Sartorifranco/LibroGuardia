const { db, FieldValue } = require('./firestore');
const { normalizeIdNumber } = require('./dniParser');
const { normalizeLegajo } = require('./lib/personMatch');
const { normalizePersonName, buildNameTokens, namesMatch } = require('./lib/nameUtils');
const { hydrateAuthorizationForRead } = require('./lib/transportCsvParser');
const { getArgentinaDateString } = require('./lib/normalize');

const AUTHORIZATION_TYPES = ['citacion', 'visit', 'visita', 'temporal', 'permanent'];

const normalizeAuthorizationType = (type = 'citacion') => {
  const normalized = String(type || 'citacion').trim().toLowerCase();
  if (normalized === 'visit') return 'visita';
  return normalized;
};

const getAuthorizationLabel = (type) => {
  const normalized = normalizeAuthorizationType(type);
  const labels = {
    citacion: 'Citación del día',
    visita: 'Visita autorizada',
    temporal: 'Autorización temporal',
    permanent: 'Autorización permanente',
    manual_override: 'Autorización manual',
    denied: 'Sin autorización',
    egreso: 'Egreso',
    persona_inactiva: 'Persona inactiva',
    no_encontrado: 'No registrado',
    sin_citacion_para_hoy: 'Sin autorización vigente'
  };
  return labels[normalized] || labels[type] || 'Sin autorización';
};

/**
 * "Hoy" en Argentina (YYYY-MM-DD). Antes usaba UTC: entre las 21:00 y las
 * 23:59 ART devolvía el día siguiente (citaciones / altas con fecha corrida).
 */
const todayDateString = (referenceDate = new Date()) => getArgentinaDateString(referenceDate);

const dateInRange = (date, startDate, endDate) => {
  if (!startDate) return false;
  const end = endDate || startDate;
  return date >= startDate && date <= end;
};

const authorizationToJSON = (doc) => hydrateAuthorizationForRead({ id: doc.id, ...doc.data() });

const buildAuthorizationRecord = ({
  type,
  name,
  idNumber,
  legajo,
  company,
  destination,
  role,
  startDate,
  endDate,
  notes,
  personId,
  importBatchId,
  source = 'import',
  active = true,
  daysOfWeek = null,
  timeWindow = null,
  appointmentTime = null
}) => {
  const authType = normalizeAuthorizationType(type);
  let idNumberNormalized = normalizeIdNumber(idNumber);
  const legajoNormalized = normalizeLegajo(legajo) || String(legajo || '').trim();
  let resolvedName = String(name || '').trim();
  if (!resolvedName && legajoNormalized) {
    resolvedName = `Legajo ${legajoNormalized}`;
  }
  if (!resolvedName) {
    throw new Error('Nombre es obligatorio');
  }

  const normalizedStart = startDate || todayDateString();
  // Evitar DNI = fecha de citación (2026-07-16 → 20260716).
  if (idNumberNormalized && idNumberNormalized === String(normalizedStart).replace(/\D/g, '')) {
    idNumberNormalized = '';
  }

  if (!idNumberNormalized && !legajoNormalized) {
    throw new Error('Se requiere DNI o legajo');
  }
  if (!AUTHORIZATION_TYPES.includes(authType) && !AUTHORIZATION_TYPES.includes(type)) {
    throw new Error('Tipo de autorización inválido');
  }

  let normalizedEnd = endDate || null;

  if (authType === 'citacion') {
    normalizedEnd = normalizedEnd || normalizedStart;
  }
  if (authType === 'permanent') {
    normalizedEnd = null;
  }
  if (['visita', 'temporal'].includes(authType) && !normalizedEnd) {
    normalizedEnd = normalizedStart;
  }

  const normalizedDays = Array.isArray(daysOfWeek)
    ? daysOfWeek.filter(Boolean)
    : null;
  const normalizedTimeWindow = timeWindow?.from && timeWindow?.to
    ? { from: String(timeWindow.from).slice(0, 5), to: String(timeWindow.to).slice(0, 5) }
    : null;
  const normalizedAppointmentTime = appointmentTime
    ? String(appointmentTime).slice(0, 5)
    : null;

  const nameKey = buildNameTokens(resolvedName);

  return {
    type: authType,
    name: resolvedName,
    nameLower: normalizePersonName(resolvedName),
    nameKey,
    nameTokens: nameKey,
    personId: personId || null,
    idNumber: idNumberNormalized || '',
    idNumberNormalized: idNumberNormalized || '',
    legajo: legajoNormalized,
    legajoNormalized,
    company: (company || '').trim(),
    destination: (destination || '').trim(),
    role: (role || '').trim(),
    startDate: normalizedStart,
    endDate: normalizedEnd,
    appointmentDate: authType === 'citacion' ? normalizedStart : null,
    appointmentTime: authType === 'citacion' ? normalizedAppointmentTime : null,
    daysOfWeek: authType === 'permanent' && normalizedDays?.length ? normalizedDays : null,
    timeWindow: authType === 'permanent' ? normalizedTimeWindow : null,
    notes: (notes || '').trim(),
    source,
    importBatchId: importBatchId || null,
    importSource: null,
    active: active !== false,
    updatedAt: FieldValue.serverTimestamp()
  };
};

const findLegacyCitacion = async (idNumberNormalized, referenceDate) => {
  const snap = await db.collection('citaciones')
    .where('idNumberNormalized', '==', idNumberNormalized)
    .where('appointmentDate', '==', referenceDate)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  return {
    id: doc.id,
    type: 'citacion',
    ...data,
    startDate: data.appointmentDate,
    endDate: data.appointmentDate
  };
};

const pickBestAuthorization = (docs, referenceDate) => {
  let match = null;

  docs.forEach((doc) => {
    const auth = { id: doc.id, ...doc.data() };
    let valid = false;
    let priority = 0;
    let reason = auth.type;

    if (auth.type === 'permanent') {
      valid = true;
      priority = 4;
      reason = 'permanent';
    } else if (['visita', 'visit', 'temporal'].includes(auth.type)
      && dateInRange(referenceDate, auth.startDate, auth.endDate)) {
      valid = true;
      priority = auth.type === 'temporal' ? 2 : 3;
      reason = auth.type === 'visit' ? 'visita' : auth.type;
    } else if (auth.type === 'citacion' && dateInRange(referenceDate, auth.startDate, auth.endDate || auth.startDate)) {
      valid = true;
      priority = 1;
      reason = 'citacion';
    }

    if (valid && (!match || priority > match.priority)) {
      match = { ...hydrateAuthorizationForRead(auth), reason, priority };
    }
  });

  return match;
};

const resolveAuthorization = async (idNumber, referenceDate = todayDateString()) => {
  const idNumberNormalized = normalizeIdNumber(idNumber);

  if (idNumberNormalized) {
    const snap = await db.collection('authorizations')
      .where('idNumberNormalized', '==', idNumberNormalized)
      .where('active', '==', true)
      .get();

    const match = pickBestAuthorization(snap.docs, referenceDate);
    if (match) return match;

    const masterSnap = await db.collection('personalMaster')
      .where('idNumberNormalized', '==', idNumberNormalized)
      .limit(1)
      .get();

    if (!masterSnap.empty) {
      const master = masterSnap.docs[0].data();
      const legajoNormalized = String(master.legajoNormalized || master.legajo || '').trim();
      if (legajoNormalized) {
        const legajoSnap = await db.collection('authorizations')
          .where('legajoNormalized', '==', legajoNormalized)
          .where('active', '==', true)
          .get();
        const legajoMatch = pickBestAuthorization(legajoSnap.docs, referenceDate);
        if (legajoMatch) return legajoMatch;
      }
    }
  }

  if (!idNumberNormalized) return null;

  const legacy = await findLegacyCitacion(idNumberNormalized, referenceDate);
  if (legacy) {
    return { ...legacy, reason: 'citacion', priority: 1 };
  }

  return null;
};

/** Identidad del titular de una autorización (para detectar homónimos). */
const authorizationHolderKey = (data = {}) => {
  if (data.personId) return `p:${data.personId}`;
  const dni = normalizeIdNumber(data.idNumberNormalized || data.idNumber);
  if (dni) return `d:${dni}`;
  const legajo = String(data.legajoNormalized || data.legajo || '').trim();
  if (legajo) return `l:${legajo}`;
  return null;
};

/**
 * Autorización por nombre. SOLO para lecturas sin DNI.
 * Exige match exacto de tokens normalizados (nameKey / nameTokens) y que todas
 * las autorizaciones encontradas pertenezcan a un único titular. Si hay
 * homónimos (o un titular sin identidad) → null. Ya no se hace el barrido
 * difuso de todas las autorizaciones activas.
 */
const resolveAuthorizationByName = async (name, referenceDate = todayDateString()) => {
  const nameTokens = buildNameTokens(name);
  if (!nameTokens) return null;

  const [byNameKey, byLegacyTokens] = await Promise.all([
    db.collection('authorizations')
      .where('nameKey', '==', nameTokens)
      .where('active', '==', true)
      .get(),
    db.collection('authorizations')
      .where('nameTokens', '==', nameTokens)
      .where('active', '==', true)
      .get()
  ]);

  const docsById = new Map();
  [...byNameKey.docs, ...byLegacyTokens.docs].forEach((doc) => docsById.set(doc.id, doc));
  const docs = [...docsById.values()];
  if (!docs.length) return null;

  const holders = new Set(docs.map((doc) => authorizationHolderKey(doc.data() || {})));
  if (holders.size !== 1 || holders.has(null)) {
    console.warn('[authorizations] Autorización por nombre ambigua (homónimos); no se resuelve', {
      nameTokens,
      candidates: docs.length
    });
    return null;
  }

  return pickBestAuthorization(docs, referenceDate);
};

const resolveAuthorizationByPersonId = async (personId, referenceDate = todayDateString()) => {
  if (!personId) return null;
  const snap = await db.collection('authorizations')
    .where('personId', '==', personId)
    .where('active', '==', true)
    .get();
  return pickBestAuthorization(snap.docs, referenceDate);
};

const resolveAuthorizationForAccess = async ({
  idNumber,
  name = '',
  referenceDate = todayDateString(),
  person = null
}) => {
  if (person?.id) {
    const byPerson = await resolveAuthorizationByPersonId(person.id, referenceDate);
    if (byPerson) return byPerson;
  }

  const byId = await resolveAuthorization(idNumber, referenceDate);
  if (byId) return byId;
  // Con DNI leído nunca se busca por nombre (homónimos). Tampoco si la persona
  // ya se resolvió en people: una autorización por nombre podría ser de otro.
  if (!normalizeIdNumber(idNumber) && !person?.id && name?.trim()) {
    return resolveAuthorizationByName(name, referenceDate);
  }
  return null;
};

const listAuthorizationsByDate = async (date, type = null) => {
  const snap = await db.collection('authorizations').where('active', '==', true).get();
  return snap.docs
    .map(authorizationToJSON)
    .filter((item) => {
      if (type && item.type !== type) return false;
      if (item.type === 'permanent') return true;
      return dateInRange(date, item.startDate, item.endDate || item.startDate);
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
};

const listAuthorizationsInRange = async (fromDate, toDate, type = null) => {
  const snap = await db.collection('authorizations').where('active', '==', true).get();
  return snap.docs
    .map(authorizationToJSON)
    .filter((item) => {
      if (type && item.type !== type) return false;
      if (item.type === 'permanent') return true;
      const start = item.startDate || '';
      const end = item.endDate || item.startDate || '';
      return start <= toDate && end >= fromDate;
    })
    .sort((a, b) => {
      const dateCmp = (a.startDate || '').localeCompare(b.startDate || '');
      if (dateCmp !== 0) return dateCmp;
      return (a.name || '').localeCompare(b.name || '');
    });
};

const listPlannedCitacionDates = async (fromDate, toDate) => {
  const items = await listAuthorizationsInRange(fromDate, toDate, 'citacion');
  const dates = [...new Set(items.map((item) => item.startDate).filter(Boolean))];
  dates.sort();
  return dates.map((date) => ({
    date,
    count: items.filter((item) => item.startDate === date).length
  }));
};

const isExternalAuthorization = (item) => {
  if (item.type === 'citacion') return false;
  if (item.source === 'nomina') return false;
  return ['visit', 'visita', 'temporal', 'permanent'].includes(item.type);
};

const listExternalAuthorizations = async (date) => {
  const snap = await db.collection('authorizations').where('active', '==', true).get();
  return snap.docs
    .map(authorizationToJSON)
    .filter((item) => {
      if (!isExternalAuthorization(item)) return false;
      if (item.type === 'permanent') return true;
      return dateInRange(date, item.startDate, item.endDate || item.startDate);
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
};

module.exports = {
  AUTHORIZATION_TYPES,
  normalizeAuthorizationType,
  todayDateString,
  dateInRange,
  buildAuthorizationRecord,
  resolveAuthorization,
  resolveAuthorizationByPersonId,
  resolveAuthorizationByName,
  resolveAuthorizationForAccess,
  normalizePersonName,
  buildNameTokens,
  namesMatch,
  getAuthorizationLabel,
  listAuthorizationsByDate,
  listAuthorizationsInRange,
  listPlannedCitacionDates,
  listExternalAuthorizations,
  isExternalAuthorization,
  authorizationToJSON
};
