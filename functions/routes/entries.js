const express = require('express');
const { db, FieldValue, Timestamp } = require('../firestore');
const { resolveOrCreatePerson } = require('../people');
const { logActivity } = require('../lib/activityLog');
const { notifySafe } = require('../lib/notifications');
const { queryEntriesPage } = require('../lib/entriesQuery');
const { triggerAccessIfAuthorized } = require('../accessControl');
const {
  auth
} = require('../middleware/auth');

const router = express.Router();

const entryToJSON = (doc, registeredByUsername) => {
  const data = doc.data();
  const timestamp = data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : data.timestamp;
  return {
    id: doc.id,
    _id: doc.id,
    ...data,
    timestamp,
    registeredByUsername
  };
};

const validateEntryPayload = (type, body) => {
  switch (type) {
    case 'personal':
      if (!body.name?.trim()) return 'El nombre es obligatorio para registros de personal';
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'vehiculo':
      if (!body.plate?.trim()) return 'La patente es obligatoria para vehículos';
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'flota':
      if (!body.mobile?.trim() || !body.flotaDriver?.trim()) {
        return 'El móvil y el chofer son obligatorios para flota';
      }
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'novedad':
      if (!body.description?.trim()) return 'La descripción es obligatoria para novedades';
      break;
    default:
      return 'Tipo de entrada inválido';
  }
  return null;
};

router.post('/api/entries', auth, async (req, res) => {
  try {
    const {
      type, movementType, eventTime, name, idNumber, company, destination,
      plate, brand, driver, description, mobile, flotaDriver, scheduledTime, actualTime,
      entrySource, authorized, authorizedStatus, allowAccessOverride, exceptionalReason
    } = req.body;

    const validationError = validateEntryPayload(type, req.body);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const entryData = {
      type,
      registeredBy: req.user.id,
      timestamp: Timestamp.now(),
      eventTime: eventTime || null
    };

    if (type === 'personal') {
      Object.assign(entryData, {
        movementType,
        name,
        idNumber,
        company,
        destination,
        entrySource: entrySource || 'manual'
      });
    } else if (type === 'vehiculo') {
      Object.assign(entryData, {
        movementType,
        plate,
        brand,
        company,
        driver,
        authorized: authorized === true,
        authorizedStatus: authorizedStatus || (authorized ? 'authorized' : 'not_authorized')
      });
    } else if (type === 'flota') {
      Object.assign(entryData, { movementType, mobile, flotaDriver, scheduledTime, actualTime });
    } else if (type === 'novedad') {
      Object.assign(entryData, { description });
    }

    const ref = await db.collection('entries').add(entryData);
    const saved = await ref.get();

    let accessResult = null;
    if (type === 'personal') {
      const userSnap = await db.collection('users').doc(req.user.id).get();
      const userPermissions = userSnap.exists ? await getUserPermissions(userSnap.data()) : [];
      const manualOverrideAllowed = userPermissions.includes('access.manual_override') || req.user.role === 'admin';
      const exceptionalAllowed = userPermissions.includes('access.exceptional_entry') || req.user.role === 'admin';
      const useExceptional = Boolean(exceptionalReason?.trim()) && exceptionalAllowed;

    accessResult = await triggerAccessIfAuthorized({
      movementType,
      idNumber,
      name,
      entrySource: entrySource || 'manual',
      entryId: ref.id,
      username: req.user.id,
      allowManualOverride: useExceptional
        ? true
        : (allowAccessOverride === true ? true : (entrySource === 'manual' ? manualOverrideAllowed : null))
    });

      const accessPatch = {
        accessAuthorized: useExceptional ? true : accessResult.authorized,
        accessReason: useExceptional ? 'ingreso_excepcional' : accessResult.reason,
        authorizationType: useExceptional ? 'ingreso_excepcional' : accessResult.authorizationType,
        relayTriggered: Boolean(accessResult.relay?.triggered),
        relayError: accessResult.relay?.error || null
      };
      if (useExceptional) {
        accessPatch.exceptionalEntry = true;
        accessPatch.exceptionalReason = exceptionalReason.trim();
        accessPatch.notes = `Ingreso excepcional: ${exceptionalReason.trim()}`;
      }

      await ref.update(accessPatch);
    }

    res.status(201).json({
      message: 'Entrada creada exitosamente',
      entry: { id: ref.id, ...saved.data(), ...(type === 'personal' ? {
        accessAuthorized: accessResult?.authorized,
        accessReason: accessResult?.reason,
        relayTriggered: accessResult?.relay?.triggered
      } : {}) },
      ...(accessResult ? { access: accessResult } : {})
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al crear entrada', error: err.message });
  }
});

router.get('/api/entries', auth, async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      limit,
      cursor,
      type,
      q,
      search
    } = req.query || {};

    const page = await queryEntriesPage(db, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit,
      cursor: cursor || null,
      type: type || 'todos',
      q: q || search || ''
    });

    const userIds = [...new Set(
      page.docs.map((doc) => doc.data().registeredBy).filter(Boolean)
    )];

    const usernames = {};
    await Promise.all(userIds.map(async (userId) => {
      const userSnap = await db.collection('users').doc(userId).get();
      usernames[userId] = userSnap.exists ? userSnap.data().username : 'Desconocido';
    }));

    const entries = page.docs.map((doc) =>
      entryToJSON(doc, usernames[doc.data().registeredBy] || 'Desconocido')
    );

    res.json({
      entries,
      page: {
        limit: page.limit,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor
      },
      meta: {
        startDate: page.startDate,
        endDate: page.endDate,
        type: type || 'todos',
        q: q || search || ''
      }
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      message: err.message || 'Error al obtener entradas',
      error: err.message
    });
  }
});

module.exports = router;
