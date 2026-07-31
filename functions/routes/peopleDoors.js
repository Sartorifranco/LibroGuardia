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
const { loadAllPeople, analyzePeopleAlerts } = require('../lib/peopleAlerts');
const { mergePeople } = require('../lib/peopleMerge');
const { auth, requireAnyPermission } = require('../middleware/auth');

const router = express.Router();

const personToJSON = personToAdminJSON;

const canPeopleManage = requireAnyPermission([
  'access.doors.manage',
  'access.control',
  'master.nomina.write'
]);

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

/** Duplicados, incompletos y sugerencias BioStar. */
router.get(
  '/api/admin/people/alerts',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const people = await loadAllPeople(2000);
      const alerts = analyzePeopleAlerts(people);
      res.json({ ok: true, ...alerts });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al analizar personas' });
    }
  }
);

/** Alias del plan: duplicados. */
router.get(
  '/api/admin/people/duplicates',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const people = await loadAllPeople(2000);
      const alerts = analyzePeopleAlerts(people);
      res.json({
        ok: true,
        duplicates: alerts.duplicates,
        incomplete: alerts.incomplete,
        counts: alerts.counts
      });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al listar duplicados' });
    }
  }
);

/** Sugerencias BioStar ↔ empleado. */
router.get(
  '/api/admin/people/biostar-suggestions',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const people = await loadAllPeople(2000);
      const alerts = analyzePeopleAlerts(people);
      res.json({
        ok: true,
        suggestions: alerts.biostarSuggestions,
        count: alerts.counts.biostarSuggestions
      });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al listar sugerencias' });
    }
  }
);

/**
 * Une dos fichas. Body: { keepId, mergeId }
 * Conserva keepId; desactiva mergeId.
 */
router.post(
  '/api/admin/people/merge',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const keepId = String(req.body?.keepId || '').trim();
      const mergeId = String(req.body?.mergeId || '').trim();
      const result = await mergePeople(keepId, mergeId, {
        ignoredSuggestion: req.body?.ignored === true
      });
      res.json({ ok: true, message: 'Personas unificadas', ...result });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al unificar personas',
        code: err.code
      });
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

      if (Object.prototype.hasOwnProperty.call(patch, 'accessCard') && patch.accessCard) {
        const conflicts = await findPeopleByField('accessCard', patch.accessCard);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con la tarjeta ${patch.accessCard}`
          });
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'biometricExternalId') && patch.biometricExternalId) {
        const conflicts = await findPeopleByField('biometricExternalId', patch.biometricExternalId);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con el ID biométrico ${patch.biometricExternalId}`
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

/** Personas con esta puerta + diagnóstico de quién puede pasar ahora. */
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

      const diagnose = String(req.query.diagnose || '1') !== '0';
      if (diagnose) {
        const { diagnoseDoorPeople } = require('../lib/doorPeopleDiagnostics');
        const result = await diagnoseDoorPeople(doorId);
        return res.json(result);
      }

      const explicitSnap = await db.collection('people')
        .where('allowedDoorIds', 'array-contains', doorId)
        .limit(500)
        .get();

      res.json({
        doorId,
        people: explicitSnap.docs.map(personToJSON),
        note: 'Solo ingresan quienes tengan esta puerta marcada explícitamente en su lista.'
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al listar personas de la puerta',
        code: err.code
      });
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
