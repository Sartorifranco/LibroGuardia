/**
 * Acciones de reparación masiva sobre people (puertas BioStar, DNI basura).
 */

const { db, FieldValue } = require('../firestore');
const { normalizeAllowedDoorIds } = require('./doorAccess');
const { looksLikeSuspiciousDni } = require('./personIdentity');
const { isBiostarOrphanRow, loadAllPeople } = require('./peopleAlerts');
const { getDoorsConfig } = require('./doorsConfig');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
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
 * Quita DNI basura (fecha / sospechoso) de fichas que lo comparten.
 * No borra la ficha: deja idNumber vacío para forzar corrección manual.
 */
const clearSuspiciousSharedDnis = async () => {
  const people = await loadAllPeople(2500);
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

module.exports = {
  repairBiostarOrphanDoors,
  clearSuspiciousSharedDnis
};
