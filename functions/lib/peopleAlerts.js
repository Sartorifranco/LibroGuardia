/**
 * Detección de duplicados / incompletos / sugerencias BioStar en people.
 */

const { db } = require('../firestore');
const { buildNameTokens } = require('./nameUtils');
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
  return {
    ...base,
    category: normalizeCategory(data.category, data),
    source: data.source || data.origen || '',
    nameKey: data.nameKey || buildNameTokens(base.name) || '',
    biostarUserId: data.biostarUserId || '',
    allowedDoorIds: normalizeAllowedDoorIds(data.allowedDoorIds)
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

const nameSimilarity = (a, b) => {
  const ta = new Set(String(a || '').split(/\s+/).filter((t) => t.length > 1));
  const tb = new Set(String(b || '').split(/\s+/).filter((t) => t.length > 1));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach((t) => { if (tb.has(t)) inter += 1; });
  return inter / Math.max(ta.size, tb.size);
};

/**
 * Agrupa duplicados fuertes y lista incompletos + sugerencias BioStar.
 */
const analyzePeopleAlerts = (people = []) => {
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
    const nk = String(p.nameKey || '').trim();
    if (nk && !dni && p.active !== false) {
      if (!byNameKey.has(nk)) byNameKey.set(nk, []);
      byNameKey.get(nk).push(p);
    }
  });

  const duplicates = [];
  byDni.forEach((group, key) => {
    if (group.length > 1) {
      duplicates.push({
        reason: 'dni',
        key,
        strength: 'high',
        people: group
      });
    }
  });
  byBio.forEach((group, key) => {
    if (group.length > 1) {
      duplicates.push({
        reason: 'biometric',
        key,
        strength: 'high',
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
        people: group
      });
    }
  });

  const incomplete = people.filter((p) => {
    if (p.active === false) return false;
    const noDni = !String(p.idNumber || '').trim();
    const badName = looksLikePlaceholderName(p.name);
    const noDoors = !p.allowedDoorIds?.length;
    const noBio = !String(p.biometricExternalId || '').trim();
    return noDni || badName || (noDoors && p.source === 'biostar') || (p.source === 'biostar' && noDni);
  }).map((p) => ({
    ...p,
    issues: [
      !String(p.idNumber || '').trim() ? 'sin_dni' : null,
      looksLikePlaceholderName(p.name) ? 'nombre_incompleto' : null,
      !p.allowedDoorIds?.length ? 'sin_puertas' : null,
      p.source === 'biostar' && !String(p.idNumber || '').trim() ? 'huerfano_biostar' : null
    ].filter(Boolean)
  }));

  const biostarOrphans = people.filter((p) =>
    p.active !== false
    && (p.source === 'biostar' || p.biometricBrand === 'suprema')
    && String(p.biometricExternalId || '').trim()
    && !String(p.idNumber || '').trim()
  );

  const withDni = people.filter((p) =>
    p.active !== false && String(p.idNumber || '').trim() && !looksLikePlaceholderName(p.name)
  );

  const suggestions = [];
  biostarOrphans.forEach((orphan) => {
    let best = null;
    let bestScore = 0;
    withDni.forEach((cand) => {
      if (cand.id === orphan.id) return;
      if (String(cand.biometricExternalId || '').trim()) return;
      const score = nameSimilarity(orphan.nameKey || orphan.name, cand.nameKey || cand.name);
      if (score >= 0.6 && score > bestScore) {
        bestScore = score;
        best = cand;
      }
    });
    if (best) {
      suggestions.push({
        orphan,
        candidate: best,
        score: Number(bestScore.toFixed(2)),
        reason: 'name_similarity'
      });
    }
  });

  suggestions.sort((a, b) => b.score - a.score);

  return {
    duplicates,
    incomplete,
    biostarSuggestions: suggestions.slice(0, 100),
    counts: {
      people: people.length,
      duplicates: duplicates.length,
      incomplete: incomplete.length,
      biostarSuggestions: Math.min(100, suggestions.length)
    }
  };
};

module.exports = {
  CATEGORIES,
  normalizeCategory,
  loadAllPeople,
  analyzePeopleAlerts,
  looksLikePlaceholderName,
  nameSimilarity
};
