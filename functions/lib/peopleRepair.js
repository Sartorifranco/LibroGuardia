/**
 * Acciones de reparación sobre people (puertas, DNI basura, DNI real sugerido).
 */

const { db, FieldValue } = require('../firestore');
const { normalizeIdNumber } = require('../dniParser');
const { normalizeAllowedDoorIds } = require('./doorAccess');
const {
  looksLikeSuspiciousDni,
  looksLikeDateDni,
  scorePersonNameMatch
} = require('./personIdentity');
const { isBiostarOrphanRow, loadAllPeople } = require('./peopleAlerts');
const { getDoorsConfig } = require('./doorsConfig');
const { mergePeople } = require('./peopleMerge');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const loadPersonalMaster = async (limit = 3000) => {
  const snap = await db.collection('personalMaster').limit(limit).get();
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      name: data.name || data.nombre || '',
      idNumber: normalizeIdNumber(data.idNumberNormalized || data.idNumber || data.dni || ''),
      legajo: String(data.legajoNormalized || data.legajo || '').trim(),
      source: data.source || '',
      personId: data.personId || null
    };
  });
};

/**
 * Huérfanos BioStar (sin DNI/legajo): dejan solo `doorId` o ninguna puerta.
 * mode: 'single' | 'clear'
 */
const repairBiostarOrphanDoors = async ({ doorId = null, mode = 'single' } = {}) => {
  const m = mode === 'clear' ? 'clear' : 'single';
  let targetDoor = String(doorId || '').trim() || null;
  if (m === 'single' && !targetDoor) {
    const cfg = await getDoorsConfig();
    targetDoor = cfg.defaultDoorId || (cfg.doors || []).find((d) => d.active !== false)?.id || null;
    if (!targetDoor) {
      throw httpError(400, 'Indicá doorId o configurá una puerta por defecto');
    }
  }

  const people = await loadAllPeople(2500);
  const targets = people.filter((p) => p.active !== false && isBiostarOrphanRow(p));
  let updated = 0;
  const results = [];

  for (const p of targets) {
    const next = m === 'clear' ? [] : normalizeAllowedDoorIds([targetDoor]);
    const prev = normalizeAllowedDoorIds(p.allowedDoorIds);
    const same = prev.length === next.length && prev.every((id) => next.includes(id));
    if (same) {
      results.push({ id: p.id, status: 'unchanged', name: p.name });
      continue;
    }
    await db.collection('people').doc(p.id).set({
      allowedDoorIds: next,
      category: p.category || 'sin_clasificar',
      updatedAt: FieldValue.serverTimestamp(),
      doorRepairAt: FieldValue.serverTimestamp(),
      doorRepairNote: m === 'clear'
        ? 'clear_biostar_orphan_doors'
        : `biostar_orphan_single:${targetDoor}`
    }, { merge: true });
    updated += 1;
    results.push({
      id: p.id,
      status: 'updated',
      name: p.name,
      before: prev,
      after: next
    });
  }

  return {
    mode: m,
    doorId: targetDoor,
    scanned: targets.length,
    updated,
    results
  };
};

/**
 * Personas con acceso a TODAS las puertas activas (efecto de la migración antigua).
 * mode:
 *  - 'clear' → []
 *  - 'default' → [defaultDoorId]
 *  - 'biostar_default_others_clear' → huérfanos BioStar → default; resto → []
 */
const repairAllDoorsAccess = async ({
  mode = 'biostar_default_others_clear',
  doorId = null,
  personIds = null
} = {}) => {
  const cfg = await getDoorsConfig();
  const activeDoors = (cfg.doors || []).filter((d) => d.active !== false && d.id);
  const activeIds = activeDoors.map((d) => String(d.id).trim()).filter(Boolean);
  const defaultDoor = String(doorId || cfg.defaultDoorId || activeIds[0] || '').trim() || null;
  if (activeIds.length < 2) {
    return { updated: 0, scanned: 0, message: 'Hay menos de 2 puertas activas; nada que corregir' };
  }

  const people = await loadAllPeople(2500);
  const idFilter = Array.isArray(personIds) && personIds.length
    ? new Set(personIds.map(String))
    : null;

  const targets = people.filter((p) => {
    if (p.active === false) return false;
    if (idFilter && !idFilter.has(p.id)) return false;
    const doors = normalizeAllowedDoorIds(p.allowedDoorIds);
    return doors.length >= activeIds.length && activeIds.every((id) => doors.includes(id));
  });

  let updated = 0;
  const results = [];

  for (const p of targets) {
    const isOrphan = isBiostarOrphanRow(p);
    let next;
    if (mode === 'default') {
      next = defaultDoor ? [defaultDoor] : [];
    } else if (mode === 'clear') {
      next = [];
    } else {
      // biostar_default_others_clear
      next = (isOrphan && defaultDoor) ? [defaultDoor] : [];
    }
    const prev = normalizeAllowedDoorIds(p.allowedDoorIds);
    const same = prev.length === next.length && prev.every((id) => next.includes(id));
    if (same) {
      results.push({ id: p.id, status: 'unchanged', name: p.name });
      continue;
    }
    await db.collection('people').doc(p.id).set({
      allowedDoorIds: next,
      updatedAt: FieldValue.serverTimestamp(),
      doorRepairAt: FieldValue.serverTimestamp(),
      doorRepairNote: `all_doors_${mode}:${next.join(',') || 'none'}`
    }, { merge: true });
    updated += 1;
    results.push({
      id: p.id,
      status: 'updated',
      name: p.name,
      before: prev,
      after: next,
      biostarOrphan: isOrphan
    });
  }

  return {
    mode,
    doorId: defaultDoor,
    activeDoorIds: activeIds,
    scanned: targets.length,
    updated,
    results
  };
};

/**
 * Quita DNI basura (fecha / sospechoso) de fichas que lo comparten.
 * No borra la ficha: deja idNumber vacío para forzar corrección manual.
 */
const clearSuspiciousSharedDnis = async ({ personIds = null } = {}) => {
  const people = await loadAllPeople(2500);
  const idFilter = Array.isArray(personIds) && personIds.length
    ? new Set(personIds.map(String))
    : null;
  const byDni = new Map();
  people.forEach((p) => {
    if (p.active === false) return;
    const dni = String(p.idNumber || '').trim();
    if (!dni) return;
    if (!byDni.has(dni)) byDni.set(dni, []);
    byDni.get(dni).push(p);
  });

  let updated = 0;
  const cleared = [];

  for (const [dni, group] of byDni.entries()) {
    const shouldClear = looksLikeSuspiciousDni(dni) || group.length >= 3;
    if (!shouldClear) continue;
    for (const p of group) {
      if (idFilter && !idFilter.has(p.id)) continue;
      await db.collection('people').doc(p.id).set({
        dni: null,
        dniNormalized: null,
        idNumber: '',
        idNumberNormalized: '',
        updatedAt: FieldValue.serverTimestamp(),
        dniClearedReason: looksLikeSuspiciousDni(dni)
          ? `suspicious_dni:${dni}`
          : `shared_dni_x${group.length}:${dni}`
      }, { merge: true });
      updated += 1;
      cleared.push({ id: p.id, name: p.name, clearedDni: dni });
    }
  }

  return { updated, cleared };
};

/**
 * Para fichas con DNI-fecha (u otro basura), busca un DNI real en:
 * 1) personalMaster (nómina / carga inicial) por nombre
 * 2) otras people con DNI real por nombre
 * 3) biometricExternalId / biostarUserId si parece DNI real
 */
const findRealDniSuggestions = async () => {
  const [people, master] = await Promise.all([
    loadAllPeople(2500),
    loadPersonalMaster(3000)
  ]);

  const masterWithDni = master.filter((m) =>
    m.idNumber && !looksLikeSuspiciousDni(m.idNumber) && m.name
  );
  const peopleWithRealDni = people.filter((p) =>
    p.active !== false
    && String(p.idNumber || '').trim()
    && !looksLikeSuspiciousDni(p.idNumber)
    && p.name
  );

  const suggestions = [];

  people.forEach((p) => {
    if (p.active === false) return;
    const badDni = String(p.idNumber || '').trim();
    if (!badDni || !looksLikeSuspiciousDni(badDni)) return;

    const candidates = [];

    // BioStar user_id como DNI real
    const bioId = String(p.biometricExternalId || p.biostarUserId || '').replace(/\D/g, '');
    if (bioId.length >= 7 && bioId.length <= 8 && !looksLikeDateDni(bioId)) {
      candidates.push({
        dni: bioId,
        source: 'biostar_user_id',
        sourceLabel: 'ID biométrico BioStar',
        name: p.name,
        score: 0.95,
        legajo: ''
      });
    }

    masterWithDni.forEach((m) => {
      const score = scorePersonNameMatch(p.name, m.name);
      if (score >= 0.72) {
        candidates.push({
          dni: m.idNumber,
          source: 'personalMaster',
          sourceLabel: m.source === 'nomina' ? 'Nómina (personalMaster)' : 'Carga inicial (personalMaster)',
          name: m.name,
          score,
          legajo: m.legajo || '',
          masterId: m.id
        });
      }
    });

    peopleWithRealDni.forEach((other) => {
      if (other.id === p.id) return;
      const score = scorePersonNameMatch(p.name, other.name);
      if (score >= 0.78) {
        candidates.push({
          dni: String(other.idNumber).trim(),
          source: 'people',
          sourceLabel: 'Otra ficha people',
          name: other.name,
          score,
          legajo: other.legajo || '',
          personId: other.id
        });
      }
    });

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] || null;
    suggestions.push({
      personId: p.id,
      personName: p.name,
      badDni,
      looksLikeDate: looksLikeDateDni(badDni),
      best,
      alternatives: candidates.slice(0, 4)
    });
  });

  suggestions.sort((a, b) => (b.best?.score || 0) - (a.best?.score || 0));
  return suggestions;
};

const setPersonDni = async (personId, dniRaw, { reason = 'manual' } = {}) => {
  const id = String(personId || '').trim();
  if (!id) throw httpError(400, 'personId obligatorio');
  const dni = normalizeIdNumber(dniRaw);
  if (!dni || looksLikeSuspiciousDni(dni)) {
    throw httpError(400, 'DNI inválido o sospechoso');
  }
  const ref = db.collection('people').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Persona no encontrada');
  await ref.set({
    dni,
    dniNormalized: dni,
    idNumber: dni,
    idNumberNormalized: dni,
    updatedAt: FieldValue.serverTimestamp(),
    dniFixedReason: reason
  }, { merge: true });
  return { id, dni };
};

const setPersonDoors = async (personId, doorIds = [], { note = 'manual' } = {}) => {
  const id = String(personId || '').trim();
  if (!id) throw httpError(400, 'personId obligatorio');
  const next = normalizeAllowedDoorIds(doorIds);
  const ref = db.collection('people').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Persona no encontrada');
  const prev = normalizeAllowedDoorIds(snap.data()?.allowedDoorIds);
  await ref.set({
    allowedDoorIds: next,
    updatedAt: FieldValue.serverTimestamp(),
    doorRepairAt: FieldValue.serverTimestamp(),
    doorRepairNote: note
  }, { merge: true });
  return { id, before: prev, after: next };
};

/**
 * Aplica UNA acción del asistente.
 * action: { type, ... }
 */
const applyCleanupAction = async (action = {}) => {
  const type = String(action.type || '').trim();
  if (!type) throw httpError(400, 'type de acción obligatorio');

  if (type === 'merge') {
    const result = await mergePeople(action.keepId, action.mergeId, {
      doorsPolicy: action.doorsPolicy || 'prefer_keep'
    });
    return { type, ok: true, result };
  }

  if (type === 'set_doors') {
    const result = await setPersonDoors(action.personId, action.doors || [], {
      note: action.note || `cleanup:${action.reason || 'set_doors'}`
    });
    return { type, ok: true, result };
  }

  if (type === 'clear_dni') {
    const r = await clearSuspiciousSharedDnis({ personIds: [action.personId] });
    return { type, ok: true, result: r };
  }

  if (type === 'set_dni') {
    const result = await setPersonDni(action.personId, action.dni, {
      reason: action.reason || `from_${action.source || 'suggestion'}`
    });
    return { type, ok: true, result };
  }

  if (type === 'clear_dni_and_set') {
    await clearSuspiciousSharedDnis({ personIds: [action.personId] });
    const result = await setPersonDni(action.personId, action.dni, {
      reason: action.reason || `from_${action.source || 'suggestion'}`
    });
    return { type, ok: true, result };
  }

  throw httpError(400, `Acción desconocida: ${type}`);
};

module.exports = {
  repairBiostarOrphanDoors,
  repairAllDoorsAccess,
  clearSuspiciousSharedDnis,
  findRealDniSuggestions,
  setPersonDni,
  setPersonDoors,
  applyCleanupAction,
  loadPersonalMaster
};
