'use strict';

/**
 * Lugares del sitio (zonas que conecta cada puerta).
 * Colección: sites/{siteId}/areas/{id}
 * El exterior es fijo: no se crea ni se borra.
 */

const { db, FieldValue } = require('../firestore');
const { markDirty } = require('./siteCompiler');
const { getDoorsConfig } = require('./doorsConfig');

const EXTERIOR_ID = 'exterior';

const siteIdOf = () => {
  const id = String(process.env.SITE_ID || 'principal').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'principal';
};

const areasCol = (siteId = siteIdOf()) => db.collection('sites').doc(siteId).collection('areas');

const slugify = (value = '') => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const exteriorArea = () => ({
  id: EXTERIOR_ID,
  name: 'Exterior',
  exterior: true,
  fixed: true
});

const toPublic = (id, data = {}) => ({
  id,
  name: String(data.name || id).trim(),
  exterior: id === EXTERIOR_ID || data.exterior === true,
  fixed: id === EXTERIOR_ID
});

const listAreas = async () => {
  const snap = await areasCol().limit(100).get();
  const stored = snap.docs
    .map((doc) => toPublic(doc.id, doc.data() || {}))
    .filter((area) => area.id !== EXTERIOR_ID)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return [exteriorArea(), ...stored];
};

const sanitizeName = (name) => {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) throw httpError(400, 'Escribí un nombre de al menos 2 letras. Por ejemplo, Oficinas.');
  if (clean.length > 60) throw httpError(400, 'El nombre es muy largo. Usá hasta 60 letras.');
  return clean;
};

const createArea = async (name) => {
  const clean = sanitizeName(name);
  if (slugify(clean) === EXTERIOR_ID || /^exterior$/i.test(clean)) {
    return exteriorArea();
  }
  const id = slugify(clean);
  if (!id) throw httpError(400, 'Usá letras o números en el nombre del lugar.');
  const ref = areasCol().doc(id);
  const prev = await ref.get();
  if (prev.exists) throw httpError(409, 'Ya existe un lugar con ese nombre.');
  const payload = { name: clean, exterior: false, updatedAt: FieldValue.serverTimestamp() };
  await ref.set(payload);
  markDirty({ doors: true });
  return toPublic(id, { name: clean });
};

const updateArea = async (id, name) => {
  const areaId = slugify(id);
  if (!areaId || areaId === EXTERIOR_ID) {
    throw httpError(400, 'El exterior no se puede renombrar. Es el afuera del predio.');
  }
  const clean = sanitizeName(name);
  const ref = areasCol().doc(areaId);
  const prev = await ref.get();
  if (!prev.exists) throw httpError(404, 'No encontramos ese lugar.');
  const before = toPublic(areaId, prev.data() || {});
  await ref.set({ name: clean, exterior: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  markDirty({ doors: true });
  return { before, after: toPublic(areaId, { name: clean }) };
};

const doorUsesArea = (door, areaId) => {
  const sides = door && door.sides;
  if (!sides || typeof sides !== 'object') return false;
  return [sides.in, sides.out].some((side) => side && (side.zoneFrom === areaId || side.zoneTo === areaId));
};

const deleteArea = async (id) => {
  const areaId = slugify(id);
  if (!areaId || areaId === EXTERIOR_ID) {
    throw httpError(400, 'El exterior no se puede borrar. Es el afuera del predio.');
  }
  const ref = areasCol().doc(areaId);
  const prev = await ref.get();
  if (!prev.exists) throw httpError(404, 'No encontramos ese lugar.');
  const doors = await getDoorsConfig();
  const used = (doors.doors || []).find((door) => door.active !== false && doorUsesArea(door, areaId));
  if (used) {
    throw httpError(409, `No se puede borrar: la puerta “${used.name || used.id}” conecta con este lugar. Cambiá esa puerta primero.`);
  }
  const before = toPublic(areaId, prev.data() || {});
  await ref.delete();
  markDirty({ doors: true });
  return before;
};

module.exports = {
  EXTERIOR_ID,
  siteIdOf,
  slugify,
  listAreas,
  createArea,
  updateArea,
  deleteArea,
  doorUsesArea
};
