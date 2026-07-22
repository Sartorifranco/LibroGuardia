/**
 * API para gestionar allowedDoorIds en people (fuente de verdad única).
 * Credenciales sin persona: allowedDoorIds vive en authorizations (mismo helper).
 */

const express = require('express');
const { db, FieldValue } = require('../firestore');
const {
  normalizeAllowedDoorIds,
  addDoorToAllowedList,
  removeDoorFromAllowedList
} = require('../lib/doorAccess');
const { auth, requireAnyPermission } = require('../middleware/auth');

const router = express.Router();

const personToJSON = (doc) => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    name: data.nombre || data.name || '',
    idNumber: data.dniNormalized || data.idNumberNormalized || data.dni || '',
    company: data.company || data.empresa || data.centroCosto || '',
    active: data.active !== false,
    allowedDoorIds: normalizeAllowedDoorIds(data.allowedDoorIds)
  };
};

/** Buscar personas (people) por nombre o DNI. Sin q: listado general. */
router.get(
  '/api/admin/people',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.personal.read', 'master.nomina.read', 'master.nomina.write']),
  async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const snap = await db.collection('people').limit(800).get();
      let people = snap.docs.map(personToJSON).filter((p) => p.active !== false);
      if (q) {
        const digits = q.replace(/\D/g, '');
        people = people.filter((p) =>
          p.name.toLowerCase().includes(q)
          || (digits && String(p.idNumber).includes(digits))
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

/** Reemplaza la lista completa (null = todas las puertas). */
router.put(
  '/api/admin/people/:id/allowed-doors',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.nomina.write']),
  async (req, res) => {
    try {
      const ref = db.collection('people').doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Persona no encontrada' });
      }
      const allowedDoorIds = Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedDoorIds')
        ? normalizeAllowedDoorIds(req.body.allowedDoorIds)
        : normalizeAllowedDoorIds(snap.data().allowedDoorIds);

      await ref.update({
        allowedDoorIds,
        updatedAt: FieldValue.serverTimestamp()
      });
      const updated = await ref.get();
      res.json({ message: 'Puertas actualizadas', person: personToJSON(updated) });
    } catch (err) {
      res.status(500).json({ message: 'Error al actualizar puertas', error: err.message });
    }
  }
);

/** Personas con esta puerta en su lista explícita (+ conteo de acceso total). */
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

      const allSnap = await db.collection('people').limit(500).get();
      let unrestrictedCount = 0;
      allSnap.docs.forEach((doc) => {
        const data = doc.data() || {};
        if (data.active === false) return;
        if (!normalizeAllowedDoorIds(data.allowedDoorIds)) unrestrictedCount += 1;
      });

      res.json({
        doorId,
        people: explicitSnap.docs.map(personToJSON),
        unrestrictedCount,
        note: 'Las personas sin lista de puertas (acceso total) también pueden ingresar por esta puerta.'
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
      const wasUnrestricted = !normalizeAllowedDoorIds(prev);
      const allowedDoorIds = addDoorToAllowedList(prev, doorId);
      await ref.update({ allowedDoorIds, updatedAt: FieldValue.serverTimestamp() });
      const updated = await ref.get();
      res.json({
        message: wasUnrestricted
          ? 'Persona restringida a lista explícita (incluye esta puerta)'
          : 'Puerta agregada a la persona',
        person: personToJSON(updated),
        wasUnrestricted
      });
    } catch (err) {
      res.status(500).json({ message: 'Error al vincular persona', error: err.message });
    }
  }
);

/** Quita la puerta de la lista; si queda vacía → acceso total (null). */
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
