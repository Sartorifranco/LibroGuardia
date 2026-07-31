/**
 * Detección de duplicados / incompletos / sugerencias BioStar en people.
 */

const { db } = require('../firestore');
const { buildNameTokens } = require('./nameUtils');
const {
  buildNameKeyWithInitials,
  scorePersonNameMatch,
  looksLikeSuspiciousDni,
  looksLikeDateDni
} = require('./personIdentity');
const { normalizeAllowedDoorIds } = require('./doorAccess');
const { personToAdminJSON } = require('./peopleProfileUpdate');

const CATEGORIES = ['empleado', 'tercero', 'cliente', 'sin_clasificar'];

const normalizeCategory = (value, person = {}) => {
  const raw = String(value || person.category || '').trim().toLowerCase();
  if (CATEGORIES.includes(raw)) return raw;
  const tipo = String(person.tipo || '').toLowerCase();
  if (tipo === 'visita' || tipo === 'cliente') return 'cliente';
  if (tipo === 'temporal' || tipo === 'tercero' || tipo === 'contratista') return 'tercero';
  if (person.source === 'biostar' && !person.dniNormalized && !person.idNumberNormalized) {
    return 'sin_clasificar';
  }
  if (tipo === 'empleado' || person.legajoNormalized || person.legajo) return 'empleado';
  if (person.source === 'biostar') return 'sin_clasificar';
  return 'sin_clasificar';
};

const toRow = (doc) => {
  const data = doc.data() || {};
  const base = personToAdminJSON(doc);
  const name = base.name || '';
  return {
    ...base,
    category: normalizeCategory(data.category, data),
    source: data.source || data.origen || '',
    nameKey: data.nameKey || buildNameKeyWithInitials(name) || buildNameTokens(name) || '',
    nameKeyFull: buildNameKeyWithInitials(name),
    biostarUserId: data.biostarUserId || '',
    allowedDoorIds: normalizeAllowedDoorIds(data.allowedDoorIds),
    hasLegajo: Boolean(String(base.legajo || '').trim()),
    isBiostarOrphan: (data.source === 'biostar' || data.biometricBrand === 'suprema')
      && Boolean(String(base.biometricExternalId || '').trim())
      && !String(base.idNumber || '').trim()
      && !String(base.legajo || '').trim()
  };
};

const loadAllPeople = async (limit = 2000) => {
  const snap = await db.collection('people').limit(limit).get();
  return snap.docs.map(toRow);
};

const looksLikePlaceholderName = (name = '') => {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^biostar\b/i.test(n)) return true;
  if (/^\d+$/.test(n)) return true;
  return false;
};

const isBiostarOrphanRow = (p) => Boolean(p.isBiostarOrphan)
  || (
    p.active !== false
    && (p.source === 'biostar' || p.biometricBrand === 'suprema')
    && String(p.biometricExternalId || '').trim()
    && !String(p.idNumber || '').trim()
    && !String(p.legajo || '').trim()
  );

/**
 * Agrupa duplicados fuertes y lista incompletos + sugerencias BioStar.
 */
const analyzePeopleAlerts = (people = [], options = {}) => {
  const activeDoorCount = Number(options.activeDoorCount) || 0;
  const byDni = new Map();
  const byBio = new Map();
  const byNameKey = new Map();

  people.forEach((p) => {
    const dni = String(p.idNumber || '').trim();
    if (dni && p.active !== false) {
      if (!byDni.has(dni)) byDni.set(dni, []);
      byDni.get(dni).push(p);
    }
    const bio = String(p.biometricExternalId || '').trim();
    if (bio) {
      if (!byBio.has(bio)) byBio.set(bio, []);
      byBio.get(bio).push(p);
    }
    const nk = String(p.nameKeyFull || p.nameKey || '').trim();
    // Solo agrupar por nombre si hay al menos 2 tokens (evita colapsar "marcos")
    const tokenCount = nk ? nk.split(/\s+/).length : 0;
    if (nk && tokenCount >= 2 && !dni && p.active !== false) {
      if (!byNameKey.has(nk)) byNameKey.set(nk, []);
      byNameKey.get(nk).push(p);
    }
  });

  const duplicates = [];
  const suspiciousDnis = [];

  byDni.forEach((group, key) => {
    if (group.length <= 1) return;
    const suspicious = looksLikeSuspiciousDni(key) || group.length >= 3;
    const entry = {
      reason: 'dni',
      key,
      strength: suspicious ? 'high' : 'high',
      suspicious: looksLikeSuspiciousDni(key),
      looksLikeDate: looksLikeDateDni(key),
      message: looksLikeDateDni(key)
        ? `El DNI ${key} parece una fecha (AAAA/MM/DD), no un documento real.`
        : looksLikeSuspiciousDni(key)
          ? `DNI ${key} es un valor sospechoso / de prueba.`
          : group.length >= 3
            ? `El DNI ${key} está en ${group.length} fichas activas (muy raro: revisar carga).`
            : `Mismo DNI en ${group.length} fichas.`,
      people: group
    };
    duplicates.push(entry);
    if (suspicious) suspiciousDnis.push(entry);
  });

  byBio.forEach((group, key) => {
    if (group.length > 1) {
      duplicates.push({
        reason: 'biometric',
        key,
        strength: 'high',
        message: `Mismo ID biométrico ${key} en ${group.length} fichas.`,
        people: group
      });
    }
  });

  byNameKey.forEach((group, key) => {
    if (group.length > 1) {
      duplicates.push({
        reason: 'name_no_dni',
        key,
        strength: 'weak',
        message: `Mismo nombre clave “${key}” sin DNI (${group.length} fichas).`,
        people: group
      });
    }
  });

  const incomplete = people.filter((p) => {
    if (p.active === false) return false;
    const noDni = !String(p.idNumber || '').trim();
    const badName = looksLikePlaceholderName(p.name);
    const noDoors = !p.allowedDoorIds?.length;
    return noDni || badName || (noDoors && p.source === 'biostar') || (p.source === 'biostar' && noDni);
  }).map((p) => ({
    ...p,
    issues: [
      !String(p.idNumber || '').trim() ? 'sin_dni' : null,
      looksLikePlaceholderName(p.name) ? 'nombre_incompleto' : null,
      !p.allowedDoorIds?.length ? 'sin_puertas' : null,
      isBiostarOrphanRow(p) ? 'huerfano_biostar' : null,
      looksLikeSuspiciousDni(p.idNumber) ? 'dni_sospechoso' : null
    ].filter(Boolean)
  }));

  const biostarOrphans = people.filter((p) => p.active !== false && isBiostarOrphanRow(p));

  const withIdentity = people.filter((p) =>
    p.active !== false
    && (String(p.idNumber || '').trim() || String(p.legajo || '').trim())
    && !looksLikePlaceholderName(p.name)
    && !looksLikeSuspiciousDni(p.idNumber)
  );

  const suggestions = [];
  biostarOrphans.forEach((orphan) => {
    let best = null;
    let bestScore = 0;
    withIdentity.forEach((cand) => {
      if (cand.id === orphan.id) return;
      // Preferir candidatos sin bio, o con bio distinto
      const score = scorePersonNameMatch(orphan.name, cand.name);
      if (score >= 0.72 && score > bestScore) {
        bestScore = score;
        best = cand;
      }
    });
    if (best) {
      suggestions.push({
        orphan,
        candidate: best,
        score: Number(bestScore.toFixed(2)),
        reason: 'name_similarity',
        message: `“${orphan.name}” (BioStar) parece la misma persona que “${best.name}” (DNI ${best.idNumber || '—'}).`
      });
    }
  });
  suggestions.sort((a, b) => b.score - a.score);

  const biostarWithManyDoors = people.filter((p) => {
    if (p.active === false) return false;
    if (!isBiostarOrphanRow(p) && p.source !== 'biostar') return false;
    const doors = p.allowedDoorIds || [];
    if (activeDoorCount > 0) return doors.length >= Math.min(2, activeDoorCount);
    return doors.length >= 2;
  });

  const allDoorsPeople = activeDoorCount > 1
    ? people.filter((p) =>
      p.active !== false
      && (p.allowedDoorIds || []).length >= activeDoorCount)
    : [];

  return {
    duplicates,
    suspiciousDnis,
    incomplete,
    biostarSuggestions: suggestions.slice(0, 100),
    biostarDoorIssues: biostarWithManyDoors,
    allDoorsPeople,
    counts: {
      people: people.length,
      duplicates: duplicates.length,
      suspiciousDnis: suspiciousDnis.length,
      incomplete: incomplete.length,
      biostarSuggestions: Math.min(100, suggestions.length),
      biostarDoorIssues: biostarWithManyDoors.length,
      allDoorsPeople: allDoorsPeople.length
    }
  };
};

module.exports = {
  CATEGORIES,
  normalizeCategory,
  loadAllPeople,
  analyzePeopleAlerts,
  looksLikePlaceholderName,
  isBiostarOrphanRow,
  scorePersonNameMatch
};
