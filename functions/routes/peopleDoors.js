/**
 * API para gestionar people: datos básicos + allowedDoorIds (fuente de verdad única).
 * Credenciales sin persona: allowedDoorIds vive en authorizations (mismo helper).
 */

const express = require('express');
const { db, FieldValue } = require('../firestore');
const {
  normalizeAllowedDoorIds,
  addDoorToAllowedList,
  removeDoorFromAllowedList
} = require('../lib/doorAccess');
const {
  personToAdminJSON,
  buildPersonProfilePatch,
  hasForeignConflict
} = require('../lib/peopleProfileUpdate');
const { auth, requireAnyPermission } = require('../middleware/auth');

const router = express.Router();

const personToJSON = personToAdminJSON;

const findPeopleByField = async (field, value) => {
  if (!value) return [];
  const snap = await db.collection('people').where(field, '==', value).limit(5).get();
  return snap.docs;
};

/** Buscar personas (people) por nombre, DNI o legajo. Incluye inactivas (admin). */
router.get(
  '/api/admin/people',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.personal.read', 'master.nomina.read', 'master.nomina.write']),
  async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const snap = await db.collection('people').limit(800).get();
      let people = snap.docs.map(personToJSON);
      if (q) {
        const digits = q.replace(/\D/g, '');
        people = people.filter((p) =>
          p.name.toLowerCase().includes(q)
          || String(p.legajo || '').toLowerCase().includes(q)
          || (digits && String(p.idNumber).includes(digits))
          || (digits && String(p.legajo || '').includes(digits))
          || p.id.toLowerCase().includes(q)
        );
      }
      people.sort((a, b) => a.name.localeCompare(b.name, 'es'));
      res.json({ people: q ? people.slice(0, 80) : people });
    } catch (err) {
      res.status(500).json({ message: 'Error al buscar personas', error: err.message });
    }
  }
);

/**
 * Actualiza datos básicos + puertas en un solo PUT.
 * Body opcional: name, legajo, idNumber, active, notas, allowedDoorIds
 */
router.put(
  '/api/admin/people/:id/allowed-doors',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.nomina.write']),
  async (req, res) => {
    try {
      const personId = String(req.params.id || '').trim();
      const ref = db.collection('people').doc(personId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Persona no encontrada' });
      }

      const existing = snap.data() || {};
      const built = buildPersonProfilePatch(existing, req.body || {});
      if (!built.ok) {
        return res.status(built.status).json({ message: built.message });
      }

      const { patch } = built;

      if (Object.prototype.hasOwnProperty.call(patch, 'legajoNormalized') && patch.legajoNormalized) {
        const conflicts = await findPeopleByField('legajoNormalized', patch.legajoNormalized);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con el legajo ${patch.legajoNormalized}`
          });
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'dniNormalized') && patch.dniNormalized) {
        const conflicts = await findPeopleByField('dniNormalized', patch.dniNormalized);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con el DNI ${patch.dniNormalized}`
          });
        }
      }

      // Compat: si no mandan allowedDoorIds, conservar el actual (comportamiento previo).
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedDoorIds')
        && !Object.prototype.hasOwnProperty.call(patch, 'allowedDoorIds')) {
        // no-op on doors
      }

      if (Object.keys(patch).length === 0) {
        return res.json({ message: 'Sin cambios', person: personToJSON(snap) });
      }

      await ref.update({
        ...patch,
        updatedAt: FieldValue.serverTimestamp()
      });
      const updated = await ref.get();
      res.json({ message: 'Persona actualizada', person: personToJSON(updated) });
    } catch (err) {
      res.status(500).json({ message: 'Error al actualizar persona', error: err.message });
    }
  }
);

/** Personas con esta puerta explícitamente en su lista. */
router.get(
  '/api/admin/doors/:doorId/people',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control']),
  async (req, res) => {
    try {
      const doorId = String(req.params.doorId || '').trim();
      if (!doorId) {
        return res.status(400).json({ message: 'doorId inválido' });
      }

      const explicitSnap = await db.collection('people')
        .where('allowedDoorIds', 'array-contains', doorId)
        .limit(200)
        .get();

      res.json({
        doorId,
        people: explicitSnap.docs.map(personToJSON),
        note: 'Solo ingresan quienes tengan esta puerta marcada explícitamente en su lista.'
      });
    } catch (err) {
      res.status(500).json({ message: 'Error al listar personas de la puerta', error: err.message });
    }
  }
);

/** Agrega la puerta a allowedDoorIds de la persona. */
router.post(
  '/api/admin/doors/:doorId/people',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control']),
  async (req, res) => {
    try {
      const doorId = String(req.params.doorId || '').trim();
      const personId = String(req.body?.personId || '').trim();
      if (!doorId || !personId) {
        return res.status(400).json({ message: 'doorId y personId son obligatorios' });
      }
      const ref = db.collection('people').doc(personId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Persona no encontrada' });
      }
      const prev = snap.data().allowedDoorIds;
      const hadNoDoors = normalizeAllowedDoorIds(prev).length === 0;
      const allowedDoorIds = addDoorToAllowedList(prev, doorId);
      await ref.update({ allowedDoorIds, updatedAt: FieldValue.serverTimestamp() });
      const updated = await ref.get();
      res.json({
        message: hadNoDoors
          ? 'Puerta agregada (antes no tenía ninguna)'
          : 'Puerta agregada a la persona',
        person: personToJSON(updated),
        hadNoDoors
      });
    } catch (err) {
      res.status(500).json({ message: 'Error al vincular persona', error: err.message });
    }
  }
);

/** Quita la puerta de la lista; si queda vacía → ninguna puerta ([]). */
router.delete(
  '/api/admin/doors/:doorId/people/:personId',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control']),
  async (req, res) => {
    try {
      const doorId = String(req.params.doorId || '').trim();
      const personId = String(req.params.personId || '').trim();
      const ref = db.collection('people').doc(personId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Persona no encontrada' });
      }
      const allowedDoorIds = removeDoorFromAllowedList(snap.data().allowedDoorIds, doorId);
      await ref.update({ allowedDoorIds, updatedAt: FieldValue.serverTimestamp() });
      const updated = await ref.get();
      res.json({ message: 'Puerta quitada de la persona', person: personToJSON(updated) });
    } catch (err) {
      res.status(500).json({ message: 'Error al desvincular persona', error: err.message });
    }
  }
);

/**
 * Sincroniza allowedDoorIds en people a partir de DNI (usado desde master-data / Personal).
 * Cuerpo: { idNumber, name?, allowedDoorIds }
 */
router.put(
  '/api/admin/people/by-dni/allowed-doors',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.nomina.write', 'entries.create']),
  async (req, res) => {
    try {
      const idNumber = String(req.body?.idNumber || '').replace(/\D/g, '');
      if (idNumber.length < 7) {
        return res.status(400).json({ message: 'DNI inválido' });
      }
      const snap = await db.collection('people')
        .where('dniNormalized', '==', idNumber)
        .limit(1)
        .get();
      if (snap.empty) {
        return res.status(404).json({
          message: 'No hay registro en people con ese DNI. Importá nómina o registrá un acceso primero.'
        });
      }
      const ref = snap.docs[0].ref;
      const allowedDoorIds = normalizeAllowedDoorIds(req.body?.allowedDoorIds);
      await ref.update({ allowedDoorIds, updatedAt: FieldValue.serverTimestamp() });
      const updated = await ref.get();
      res.json({ message: 'Puertas actualizadas', person: personToJSON(updated) });
    } catch (err) {
      res.status(500).json({ message: 'Error al actualizar por DNI', error: err.message });
    }
  }
);

module.exports = router;
module.exports.personToJSON = personToJSON;
module.exports.buildPersonProfilePatch = buildPersonProfilePatch;
module.exports.hasForeignConflict = hasForeignConflict;
