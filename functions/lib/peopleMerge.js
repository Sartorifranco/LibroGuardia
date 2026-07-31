/**
 * Fusión de fichas people (keep + merge → keep).
 */

const { db, FieldValue } = require('../firestore');
const { normalizeAllowedDoorIds } = require('./doorAccess');
const { personToAdminJSON } = require('./peopleProfileUpdate');
const { normalizeCategory } = require('./peopleAlerts');

const httpError = (status, message, code) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const unionDoors = (a, b) => {
  const set = new Set([
    ...normalizeAllowedDoorIds(a),
    ...normalizeAllowedDoorIds(b)
  ]);
  return [...set];
};

const pickPrefer = (keepVal, mergeVal) => {
  const k = keepVal == null ? '' : String(keepVal).trim();
  const m = mergeVal == null ? '' : String(mergeVal).trim();
  if (k) return keepVal;
  return mergeVal == null ? keepVal : mergeVal;
};

/**
 * Une mergeId dentro de keepId. Desactiva mergeId.
 */
const mergePeople = async (keepId, mergeId, {
  ignoredSuggestion = false,
  doorsPolicy = 'union'
} = {}) => {
  const keep = String(keepId || '').trim();
  const merge = String(mergeId || '').trim();
  if (!keep || !merge) throw httpError(400, 'keepId y mergeId son obligatorios');
  if (keep === merge) throw httpError(400, 'No se puede unir una ficha consigo misma');

  const keepRef = db.collection('people').doc(keep);
  const mergeRef = db.collection('people').doc(merge);
  const [keepSnap, mergeSnap] = await Promise.all([keepRef.get(), mergeRef.get()]);
  if (!keepSnap.exists) throw httpError(404, 'Persona canónica no encontrada');
  if (!mergeSnap.exists) throw httpError(404, 'Persona a fusionar no encontrada');

  const keepData = keepSnap.data() || {};
  const mergeData = mergeSnap.data() || {};

  const keepDoors = normalizeAllowedDoorIds(keepData.allowedDoorIds);
  const mergeDoors = normalizeAllowedDoorIds(mergeData.allowedDoorIds);
  let nextDoors = keepDoors;
  if (doorsPolicy === 'union') {
    nextDoors = unionDoors(keepDoors, mergeDoors);
  } else if (doorsPolicy === 'prefer_keep') {
    // Conserva puertas del canónico; si no tenía ninguna, usa las del merge.
    nextDoors = keepDoors.length ? keepDoors : mergeDoors;
  }

  const patch = {
    name: pickPrefer(keepData.name || keepData.nombre, mergeData.name || mergeData.nombre),
    nombre: pickPrefer(keepData.nombre || keepData.name, mergeData.nombre || mergeData.name),
    dniNormalized: pickPrefer(keepData.dniNormalized, mergeData.dniNormalized) || null,
    dni: pickPrefer(keepData.dni, mergeData.dni) || null,
    idNumber: pickPrefer(keepData.idNumber, mergeData.idNumber) || '',
    idNumberNormalized: pickPrefer(keepData.idNumberNormalized, mergeData.idNumberNormalized) || '',
    legajo: pickPrefer(keepData.legajo, mergeData.legajo) || null,
    legajoNormalized: pickPrefer(keepData.legajoNormalized, mergeData.legajoNormalized) || null,
    accessCard: pickPrefer(keepData.accessCard, mergeData.accessCard) || null,
    biometricExternalId: pickPrefer(keepData.biometricExternalId, mergeData.biometricExternalId) || null,
    biometricBrand: pickPrefer(keepData.biometricBrand, mergeData.biometricBrand) || null,
    biostarUserId: pickPrefer(keepData.biostarUserId, mergeData.biostarUserId) || null,
    photoDataUrl: pickPrefer(keepData.photoDataUrl, mergeData.photoDataUrl) || null,
    notas: pickPrefer(keepData.notas, mergeData.notas) || '',
    company: pickPrefer(keepData.company, mergeData.company) || '',
    allowedDoorIds: nextDoors,
    category: normalizeCategory(
      pickPrefer(keepData.category, mergeData.category),
      { ...mergeData, ...keepData, dniNormalized: pickPrefer(keepData.dniNormalized, mergeData.dniNormalized) }
    ),
    active: keepData.active !== false,
    mergedFromIds: FieldValue.arrayUnion(merge),
    updatedAt: FieldValue.serverTimestamp()
  };
  if (patch.name) {
    patch.nombre = patch.name;
  }
  if (mergeData.source === 'biostar' || keepData.source === 'biostar') {
    patch.source = keepData.source === 'biostar' && !keepData.dniNormalized
      ? (mergeData.source || keepData.source)
      : (keepData.source || mergeData.source || 'merge');
  }

  await keepRef.set(patch, { merge: true });
  await mergeRef.set({
    active: false,
    mergedIntoId: keep,
    mergeIgnored: ignoredSuggestion === true,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  // Re-link personalMaster
  const masterSnap = await db.collection('personalMaster')
    .where('personId', '==', merge)
    .limit(20)
    .get();
  await Promise.all(masterSnap.docs.map((d) => d.ref.set({
    personId: keep,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true })));

  // Re-link authorizations (best-effort)
  try {
    const authSnap = await db.collection('authorizations')
      .where('personId', '==', merge)
      .limit(50)
      .get();
    await Promise.all(authSnap.docs.map((d) => d.ref.set({
      personId: keep,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })));
  } catch {
    // índice opcional
  }

  const updated = await keepRef.get();
  return {
    person: personToAdminJSON(updated),
    mergedId: merge,
    keptId: keep
  };
};

module.exports = {
  mergePeople,
  unionDoors
};
